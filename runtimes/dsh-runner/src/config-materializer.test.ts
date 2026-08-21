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
        model: 'fixture-model',
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
      model: 'fixture-model',
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
        model: 'fixture-model',
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
});
