import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildControlPlane, type RunnerAdminClient, type UserConfigMaterializer } from './app.js';
import type { ModelConfigRecord, UserRecord } from './domain.js';
import { registerDshGateway } from './gateway.js';
import { MemoryPlatformRepository } from './memory-repository.js';
import { SecretCipher } from './security.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const openApps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('model configuration activation', () => {
  it('marks a failed file stage and leaves the active DB config unchanged', async () => {
    const harness = await createHarness({
      materializer: {
        stage: async () => {
          throw new Error('materialize_failed');
        },
        activate: async () => undefined,
        rollback: async () => undefined,
      },
    });

    const response = await putConfig(harness, 0);

    expect(response.statusCode).toBe(500);
    expect(await harness.repository.getModelConfig(userId)).toBeNull();
    expect([...harness.repository.modelConfigStages.values()]).toMatchObject([
      { state: 'failed', errorCode: 'Error' },
    ]);
  });

  it('can retry after Runner stop fails without activating new credentials', async () => {
    let stopAttempts = 0;
    const harness = await createHarness({
      runnerAdminClient: runnerAdmin(async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error('stop_failed');
      }),
    });

    expect((await putConfig(harness, 0)).statusCode).toBe(500);
    expect(await harness.repository.getModelConfig(userId)).toBeNull();
    expect(harness.marker.active).toBe(false);

    const retried = await putConfig(harness, 0);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ version: 1 });
    expect((await harness.repository.getModelConfig(userId))?.configVersion).toBe(1);
    expect(stopAttempts).toBe(2);
    expect(harness.marker.active).toBe(true);
    expect([...harness.repository.modelConfigStages.values()].map((stage) => stage.state)).toEqual([
      'failed',
      'active',
    ]);
  });

  it('rolls back the active file marker when DB activation fails', async () => {
    const harness = await createHarness();
    harness.repository.activateModelConfig = async () => {
      throw new Error('db_activate_failed');
    };

    const response = await putConfig(harness, 0);

    expect(response.statusCode).toBe(500);
    expect(await harness.repository.getModelConfig(userId)).toBeNull();
    expect(harness.marker.activations).toBe(1);
    expect(harness.marker.rollbacks).toBe(1);
    expect(harness.marker.active).toBe(false);
    expect([...harness.repository.modelConfigStages.values()][0]).toMatchObject({
      state: 'failed',
      errorCode: 'Error',
    });
  });

  it('does not start a Runner while DB staging fails', async () => {
    const ensureVersions: number[] = [];
    const harness = await createHarness({ ensureVersions });
    harness.repository.stageModelConfig = async () => {
      throw new Error('db_stage_failed');
    };

    expect((await putConfig(harness, 0)).statusCode).toBe(500);
    expect(ensureVersions).toEqual([]);
    expect(harness.marker.activations).toBe(0);
  });

  it('serializes concurrent chat until the new config is fully active', async () => {
    const stop = deferred<void>();
    const stopStarted = deferred<void>();
    const ensureVersions: number[] = [];
    const harness = await createHarness({
      ensureVersions,
      runnerAdminClient: runnerAdmin(async () => {
        stopStarted.resolve();
        await stop.promise;
      }),
    });
    await harness.repository.putModelConfig(modelConfig(), 0);

    const update = putConfig(harness, 1, 'fixture-model-v2');
    await stopStarted.promise;
    const chat = rpc(harness, 'session.list', {});
    await delay(15);
    expect(ensureVersions).toEqual([]);

    stop.resolve();
    expect((await update).statusCode).toBe(200);
    expect((await chat).statusCode).toBe(200);
    expect(ensureVersions).toEqual([2]);
    expect((await harness.repository.getModelConfig(userId))?.configVersion).toBe(2);
  });

  it('uses the configured private URL allowlist validator for the default connection probe', async () => {
    const validated: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ object: 'list', data: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const harness = await createHarness({
      validateModelUrl: async (value) => {
        validated.push(value);
        return new URL(value);
      },
    });
    const baseUrl = 'http://host.docker.internal:43123/v1';

    const response = await harness.app.inject({
      method: 'POST',
      url: '/company-api/v1/model-config/test',
      headers: { cookie: harness.cookie, 'x-csrf-token': harness.csrf },
      payload: { base_url: baseUrl, model: 'fixture-model', api_key: 'fixture-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, error_code: null });
    expect(validated).toEqual([baseUrl, baseUrl]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${baseUrl}/models`);
  });
});

async function createHarness(
  options: {
    materializer?: UserConfigMaterializer;
    runnerAdminClient?: RunnerAdminClient;
    ensureVersions?: number[];
    validateModelUrl?: (value: string) => Promise<URL>;
  } = {},
) {
  const repository = new MemoryPlatformRepository(tenantId);
  const now = new Date();
  const user: UserRecord = {
    id: userId,
    tenantId,
    username: 'dev_a',
    displayName: 'Dev A',
    platformRole: 'member',
    status: 'active',
    version: 1,
    passwordHash: await argon2.hash('password-123', { type: argon2.argon2id }),
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
  };
  repository.users.set(user.id, user);
  const marker = { active: false, activations: 0, rollbacks: 0 };
  const materializer: UserConfigMaterializer = options.materializer ?? {
    stage: async (input) => ({
      stageId: input.stageId,
      userId: input.userId,
      configVersion: input.config.configVersion,
    }),
    activate: async () => {
      marker.active = true;
      marker.activations += 1;
    },
    rollback: async () => {
      marker.active = false;
      marker.rollbacks += 1;
    },
  };
  const app = buildControlPlane({
    repository,
    secretCipher: new SecretCipher(Buffer.alloc(32, 7)),
    validateModelUrl: options.validateModelUrl ?? (async (value) => new URL(value)),
    configMaterializer: materializer,
    runnerAdminClient: options.runnerAdminClient ?? runnerAdmin(async () => undefined),
  });
  registerGateway(app, repository, options.ensureVersions ?? []);
  openApps.push(app);
  const login = await app.inject({
    method: 'POST',
    url: '/company-api/v1/auth/login',
    payload: { username: 'dev_a', password: 'password-123' },
  });
  return {
    app,
    repository,
    marker,
    cookie: cookieHeader(login.headers['set-cookie']),
    csrf: login.json().csrf_token as string,
  };
}

function runnerAdmin(stopForUser: (userId: string) => Promise<void>): RunnerAdminClient {
  return {
    list: async () => [],
    stop: async () => ({}),
    stopForUser: async (userId) => stopForUser(userId),
  };
}

function modelConfig(): ModelConfigRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    userId,
    baseUrl: 'https://model.example/v1',
    model: 'fixture-model-v1',
    temperature: 0.7,
    maxOutputTokens: 2048,
    apiKeyCiphertext: null,
    apiKeyHint: null,
    configVersion: 0,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function putConfig(
  harness: Awaited<ReturnType<typeof createHarness>>,
  expectedVersion: number,
  model = 'fixture-model',
) {
  return harness.app.inject({
    method: 'PUT',
    url: '/company-api/v1/model-config',
    headers: { cookie: harness.cookie, 'x-csrf-token': harness.csrf },
    payload: {
      base_url: 'https://model.example/v1',
      model,
      api_key: 'fixture-key-not-real',
      expected_version: expectedVersion,
    },
  });
}

function registerGateway(
  app: Awaited<ReturnType<typeof createHarness>>['app'],
  repository: MemoryPlatformRepository,
  ensureVersions: number[],
) {
  registerDshGateway(app, {
    repository,
    runnerIdentitySecret: Buffer.alloc(32, 8),
    runnerLocator: {
      ensure: async (input) => {
        ensureVersions.push(input.configVersion);
        return { runnerId: randomUUID(), internalEndpoint: 'http://runner-user-a:3000' };
      },
    },
    fetch: async (_url, init) => {
      const envelope = JSON.parse(String(init?.body)) as { rpcId: string };
      return Response.json({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value: { items: [] } },
      });
    },
  });
}

async function rpc(
  harness: Awaited<ReturnType<typeof createHarness>>,
  method: string,
  payload: Record<string, unknown>,
) {
  return harness.app.inject({
    method: 'POST',
    url: `/chat/api/${method}`,
    headers: { cookie: harness.cookie },
    payload: { type: 'client-request', rpcId: randomUUID(), method, payload },
  });
}

function cookieHeader(value: string | string[] | undefined): string {
  const lines = Array.isArray(value) ? value : value ? [value] : [];
  return lines.map((line) => line.split(';', 1)[0]).join('; ');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
