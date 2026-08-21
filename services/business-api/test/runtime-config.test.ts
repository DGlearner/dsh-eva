import { describe, expect, it } from 'vitest';

import { FakeBusinessRepository } from '../src/adapters/fake/fake-business-repository.js';
import { loadBusinessRuntimeConfig, type BusinessRuntimeConfig } from '../src/config.js';
import { startBusinessRuntime } from '../src/runtime.js';
import { SECRET } from './helpers.js';

const integrationEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  HOST: '0.0.0.0',
  PORT: '3102',
  DATABASE_URL: 'postgresql://company:secret@postgres:5432/company_dsh',
  BUSINESS_REPOSITORY: 'postgres',
  KNOWLEDGE_PROVIDER: 'fake',
  AUTOMATION_PROVIDER: 'fake',
  ACTOR_TOKEN_SECRET: SECRET,
  ACTOR_TOKEN_ISSUER: 'company-control-plane',
};

describe('Business runtime configuration', () => {
  it('accepts the explicit PostgreSQL plus fixed fake integration mode', () => {
    expect(loadBusinessRuntimeConfig(integrationEnv)).toMatchObject({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3102,
      repositoryMode: 'postgres',
      knowledgeMode: 'fake',
      automationMode: 'fake',
      databaseUrl: integrationEnv.DATABASE_URL,
      actorTokenSecret: SECRET,
    });
  });

  it.each([
    { BUSINESS_REPOSITORY: 'fake' },
    { AUTOMATION_PROVIDER: 'fake' },
    { KNOWLEDGE_PROVIDER: 'fake' },
  ])('rejects every production fake selection without fallback', (override) => {
    expect(() =>
      loadBusinessRuntimeConfig({
        ...integrationEnv,
        NODE_ENV: 'production',
        BUSINESS_REPOSITORY: 'postgres',
        AUTOMATION_PROVIDER: 'internal',
        KNOWLEDGE_PROVIDER: 'remote-mcp',
        INTERNAL_AUTOMATION_BASE_URL: 'http://control-plane:8080',
        INTERNAL_AUTOMATION_SERVICE_TOKEN: 'service-token',
        ...override,
      }),
    ).toThrow(/rejects every fake/);
  });

  it('rejects missing secrets, invalid providers, and reserved remote MCP', () => {
    expect(() =>
      loadBusinessRuntimeConfig({ ...integrationEnv, ACTOR_TOKEN_SECRET: undefined }),
    ).toThrow(/ACTOR_TOKEN_SECRET is required/);
    expect(() =>
      loadBusinessRuntimeConfig({ ...integrationEnv, AUTOMATION_PROVIDER: 'fallback' }),
    ).toThrow(/AUTOMATION_PROVIDER must be one of/);
    expect(() =>
      loadBusinessRuntimeConfig({ ...integrationEnv, KNOWLEDGE_PROVIDER: 'remote-mcp' }),
    ).toThrow(/not implemented/);
  });

  it('checks repository health before listening and closes cleanly once', async () => {
    const repository = new FakeBusinessRepository();
    let closed = 0;
    const originalClose = repository.close.bind(repository);
    repository.close = async () => {
      closed += 1;
      await originalClose();
    };
    const runtime = await startBusinessRuntime(fakeConfig(), {
      createFakeRepository: () => repository,
      logger: false,
    });
    expect((await fetch(`${runtime.address}/healthz`)).status).toBe(200);
    await runtime.close();
    await runtime.close();
    expect(closed).toBe(1);
  });
});

function fakeConfig(): BusinessRuntimeConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    repositoryMode: 'fake',
    databaseUrl: null,
    automationMode: 'fake',
    internalAutomationBaseUrl: null,
    internalAutomationServiceToken: null,
    knowledgeMode: 'fake',
    actorTokenSecret: SECRET,
    actorTokenIssuer: 'company-control-plane',
  };
}
