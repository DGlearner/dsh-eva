import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RunnerConfigMaterializer } from './config-materializer.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const stageId = '00000000-0000-4000-8000-000000000101';

describe('RunnerConfigMaterializer', () => {
  it('writes DSH settings, credentials, identity, and a non-secret model policy', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    const stage = await materializer.stage({
      stageId,
      tenantId,
      userId,
      username: 'dev_a',
      displayName: 'Dev A',
      model: {
        baseUrl: 'https://model.example/v1',
        defaultModel: 'fixture-model',
        models: ['fixture-model', 'fixture-reasoner'],
        temperature: 0.7,
        maxOutputTokens: 2048,
        configVersion: 3,
      },
      apiKey: 'fixture-key-not-real',
      knowledge: { provider: 'fake', remoteMcpEnabled: false },
    });
    await materializer.activate(stage);
    const home = stage.homePath;

    const settings = await readFile(join(home, 'settings.yaml'), 'utf8');
    expect(settings).toContain('llm-pi-ai:\n  providers:\n    company-model:');
    expect(settings).toContain('baseURL: "https://model.example/v1"');
    expect(settings).toContain('- id: "fixture-model"');
    expect(settings).toContain('- id: "fixture-reasoner"');
    expect(settings).toContain('agent-default-model:\n  provider: company-model');
    expect(settings).not.toContain('fixture-key-not-real');

    const credentialsPath = join(home, '.credentials.yaml');
    expect(await readFile(credentialsPath, 'utf8')).toBe(
      'COMPANY_MODEL_API_KEY: "fixture-key-not-real"\n',
    );
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);

    expect(JSON.parse(await readFile(join(home, '.company', 'model.json'), 'utf8'))).toEqual({
      baseUrl: 'https://model.example/v1',
      defaultModel: 'fixture-model',
      models: ['fixture-model', 'fixture-reasoner'],
      temperature: 0.7,
      maxOutputTokens: 2048,
      configVersion: 3,
    });
    expect(JSON.parse(await readFile(join(home, '.company', 'identity.json'), 'utf8'))).toEqual({
      tenant_id: tenantId,
      user_id: userId,
      username: 'dev_a',
      display_name: 'Dev A',
    });
    expect(JSON.parse(await readFile(join(stage.userRoot, 'active-config.json'), 'utf8'))).toEqual({
      stage_id: stageId,
      config_version: 3,
      home_path: home,
    });
  });

  it('keeps the credential reference configured when no key is stored', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-empty-key-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    const stage = await materializer.stage({
      stageId,
      tenantId,
      userId,
      username: 'dev_a',
      displayName: 'Dev A',
      model: {
        baseUrl: 'https://model.example/v1',
        defaultModel: 'fixture-model',
        models: ['fixture-model'],
        temperature: 0,
        maxOutputTokens: null,
        configVersion: 1,
      },
      apiKey: null,
      knowledge: { provider: 'fake', remoteMcpEnabled: false },
    });
    await materializer.activate(stage);
    const home = stage.homePath;

    expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toBe('{}\n');
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain(
      'apiKeyEnv: COMPANY_MODEL_API_KEY',
    );
  });

  it('tracks the aggregate Runner version separately from the model version', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-runner-version-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    const stage = await materializer.stage({
      stageId,
      tenantId,
      userId,
      username: 'dev_a',
      displayName: 'Dev A',
      model: { configured: false, configVersion: 1 },
      runnerConfigVersion: 7,
      apiKey: null,
      knowledge: { provider: 'disabled' },
    });
    await materializer.activate(stage);

    expect(stage.configVersion).toBe(7);
    expect(stage.homePath).toContain(`/7-${stageId}/home`);
    await expect(materializer.hasActiveVersion({ userId, configVersion: 7 })).resolves.toBe(true);
    await expect(materializer.hasActiveVersion({ userId, configVersion: 6 })).resolves.toBe(false);
    expect(
      JSON.parse(await readFile(join(stage.homePath, '.company', 'model.json'), 'utf8')),
    ).toEqual({ configured: false, configVersion: 1 });
  });

  it('materializes a usable DSH home before a model is configured', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-unconfigured-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    const stage = await materializer.stage({
      stageId,
      tenantId,
      userId,
      username: 'dev_a',
      displayName: 'Dev A',
      model: { configured: false, configVersion: 1 },
      apiKey: null,
      knowledge: { provider: 'fake', remoteMcpEnabled: false },
    });
    await materializer.activate(stage);

    expect(await readFile(join(stage.homePath, 'settings.yaml'), 'utf8')).toBe('{}\n');
    expect(
      await materializer.hasActiveStage({
        stageId: stage.stageId,
        userId: stage.userId,
        configVersion: stage.configVersion,
      }),
    ).toBe(true);
    expect(
      await materializer.hasActiveStage({
        stageId: '00000000-0000-4000-8000-000000000099',
        userId: stage.userId,
        configVersion: stage.configVersion,
      }),
    ).toBe(false);
    expect(await readFile(join(stage.homePath, '.credentials.yaml'), 'utf8')).toBe('{}\n');
    expect(
      JSON.parse(await readFile(join(stage.homePath, '.company', 'model.json'), 'utf8')),
    ).toEqual({ configured: false, configVersion: 1 });
    expect(
      await readFile(join(stage.homePath, '.agent-presets/company/agent.cordis.yml'), 'utf8'),
    ).toContain('company-knowledge-plugin.mjs');
  });

  it('accepts an explicitly disabled Knowledge provider in production', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-disabled-knowledge-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    const stage = await materializer.stage({
      stageId,
      tenantId,
      userId,
      username: 'dev_a',
      displayName: 'Dev A',
      model: {
        baseUrl: 'https://model.example/v1',
        defaultModel: 'fixture-model',
        models: ['fixture-model'],
        temperature: 0,
        maxOutputTokens: null,
        configVersion: 1,
      },
      apiKey: null,
      knowledge: { provider: 'disabled' },
      production: true,
    });

    expect(
      JSON.parse(await readFile(join(stage.homePath, '.company', 'knowledge.json'), 'utf8')),
    ).toEqual({ provider: 'disabled' });
  });

  it('materializes a per-user remote MCP credential without embedding it in Cordis config', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-remote-mcp-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    const stage = await materializer.stage({
      stageId,
      tenantId,
      userId,
      username: 'wdl',
      displayName: 'Wu Dilong',
      model: { configured: false, configVersion: 1 },
      apiKey: null,
      knowledge: {
        provider: 'remote-mcp',
        remoteMcpEnabled: true,
        mcpUrl: 'https://knowledge.example/mcp',
        authSecretRef: 'XIAOPAI_MCP_PAT',
      },
      knowledgeCredential: 'ragmcp_test-only-token',
    });

    const preset = await readFile(
      join(stage.homePath, '.agent-presets/company/agent.cordis.yml'),
      'utf8',
    );
    expect(preset).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(preset).toContain('serverName: xiaopai');
    expect(preset).toContain('url: "https://knowledge.example/mcp"');
    expect(preset).toContain('process.env.XIAOPAI_MCP_PAT');
    expect(preset).not.toContain('ragmcp_test-only-token');
    expect(await readFile(join(stage.homePath, '.env'), 'utf8')).toBe(
      'XIAOPAI_MCP_PAT="ragmcp_test-only-token"\n',
    );
    expect((await stat(join(stage.homePath, '.env'))).mode & 0o777).toBe(0o600);
  });

  it('rejects remote MCP materialization without a per-user credential', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-materializer-remote-mcp-missing-'));
    const materializer = new RunnerConfigMaterializer(dataRoot);
    await expect(
      materializer.stage({
        stageId,
        tenantId,
        userId,
        username: 'wdl',
        displayName: 'Wu Dilong',
        model: { configured: false, configVersion: 1 },
        apiKey: null,
        knowledge: {
          provider: 'remote-mcp',
          remoteMcpEnabled: true,
          mcpUrl: 'https://knowledge.example/mcp',
          authSecretRef: 'XIAOPAI_MCP_PAT',
        },
      }),
    ).rejects.toThrow('materialized user credential');
  });
});
