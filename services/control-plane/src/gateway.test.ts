import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { buildControlPlane } from './app.js';
import type { ModelConfigRecord, UserRecord, WebSessionRecord } from './domain.js';
import {
  normalizeWebSocketCloseCode,
  registerDshGateway,
  type DshRunnerLocator,
} from './gateway.js';
import { MemoryPlatformRepository } from './memory-repository.js';
import { createSessionRecord, SecretCipher } from './security.js';
import { SessionIndexBridge } from './session-index-bridge.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userAId = '00000000-0000-4000-8000-000000001003';
const userBId = '00000000-0000-4000-8000-000000001004';
const apps: ReturnType<typeof buildControlPlane>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('DSH Gateway', () => {
  it('maps reserved and invalid upstream WebSocket close codes to an allowed code', () => {
    expect([1004, 1005, 1006, 2999, 5000, Number.NaN].map(normalizeWebSocketCloseCode)).toEqual([
      1011, 1011, 1011, 1011, 1011, 1011,
    ]);
    expect([1000, 1001, 1013, 3000, 4999].map(normalizeWebSocketCloseCode)).toEqual([
      1000, 1001, 1013, 3000, 4999,
    ]);
  });

  it('rejects unauthenticated and privileged RPCs before locating a runner', async () => {
    const fixture = createFixture();
    let located = 0;
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: {
        ensure: async () => {
          located += 1;
          throw new Error('not expected');
        },
      },
      runnerIdentitySecret: Buffer.alloc(32, 1),
    });
    const body = envelope('settings.update', {});
    const unauthenticated = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/settings.update',
      payload: body,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/settings.update',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: body,
    });
    expect(authenticated.statusCode).toBe(403);
    expect(authenticated.json().code).toBe('dsh_method_denied');
    expect(located).toBe(0);
  });

  it('returns 404 for another user Session and never calls that runner', async () => {
    const fixture = createFixture();
    const bridge = new SessionIndexBridge(fixture.repository);
    await bridge.register({ tenantId, userId: userBId }, { sessionId: 'session-b' });
    let located = 0;
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: {
        ensure: async () => {
          located += 1;
          throw new Error('not expected');
        },
      },
      runnerIdentitySecret: Buffer.alloc(32, 2),
      sessionBridge: bridge,
    });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/session.history',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: envelope('session.history', { sessionId: 'session-b' }),
    });
    expect(response.statusCode).toBe(404);
    expect(located).toBe(0);
  });

  it('strips browser cookies and indexes a Session created by the fixed user runner', async () => {
    const fixture = createFixture();
    let upstreamHeaders: Headers | undefined;
    const locator: DshRunnerLocator = {
      ensure: async () => ({ runnerId: randomUUID(), internalEndpoint: 'http://runner-a:3000' }),
    };
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: locator,
      runnerIdentitySecret: Buffer.alloc(32, 3),
      fetch: async (_url, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return Response.json({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: { sessionId: 'session-a' } },
        });
      },
    });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/session.create',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: envelope('session.create', {}),
    });
    expect(response.statusCode).toBe(200);
    expect(upstreamHeaders?.has('cookie')).toBe(false);
    expect(upstreamHeaders?.get('authorization')).toMatch(/^Bearer /u);
    expect(await fixture.repository.getSession(userAId, 'session-a')).toMatchObject({
      userId: userAId,
    });
  });

  it('allows the host description required by the official Web client', async () => {
    const fixture = createFixture();
    let upstreamUrl = '';
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: fixedRunnerLocator(),
      runnerIdentitySecret: Buffer.alloc(32, 4),
      fetch: async (url) => {
        upstreamUrl = String(url);
        return Response.json({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: { canOpenPath: false } },
        });
      },
    });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/host.describe',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: envelope('host.describe', {}),
    });
    expect(response.statusCode).toBe(200);
    expect(upstreamUrl).toBe('http://runner-a:3000/api/host.describe');
  });

  it('allows only the onboarding acknowledgement through the DSH settings boundary', async () => {
    const fixture = createFixture();
    const upstreamUrls: string[] = [];
    const upstreamBodies: unknown[] = [];
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: fixedRunnerLocator(),
      runnerIdentitySecret: Buffer.alloc(32, 4),
      fetch: async (url, init) => {
        upstreamUrls.push(String(url));
        upstreamBodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: { namespaces: [] } },
        });
      },
    });
    const headers = { cookie: `company_session=${fixture.token}` };

    const described = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/settings.describe',
      headers,
      payload: envelope('settings.describe', {}),
    });
    const acknowledgement = {
      ns: 'ui-onboarding',
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-08-13.1' }],
    };
    const mutated = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/settings.mutate',
      headers,
      payload: envelope('settings.mutate', acknowledgement),
    });

    expect(described.statusCode).toBe(200);
    expect(mutated.statusCode).toBe(200);
    expect(upstreamUrls).toEqual([
      'http://runner-a:3000/api/settings.describe',
      'http://runner-a:3000/api/settings.mutate',
    ]);
    expect(upstreamBodies).toEqual([
      envelope('settings.describe', {}),
      envelope('settings.mutate', acknowledgement),
    ]);
  });

  it('limits the DSH directory browser to the isolated user workspaces mount', async () => {
    const fixture = createFixture();
    const upstreamBodies: unknown[] = [];
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: fixedRunnerLocator(),
      runnerIdentitySecret: Buffer.alloc(32, 4),
      fetch: async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: {} },
        });
      },
    });
    const headers = { cookie: `company_session=${fixture.token}` };

    for (const [method, payload] of [
      ['host.listDirectory', {}],
      ['host.listDirectory', { path: '/dsh-user/workspaces/project-a' }],
      ['host.createDirectory', { path: '/dsh-user/workspaces', name: 'project-b' }],
    ] as const) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: `/chat/api/${method}`,
        headers,
        payload: envelope(method, payload),
      });
      expect(response.statusCode).toBe(200);
    }

    expect(upstreamBodies).toEqual([
      envelope('host.listDirectory', { path: '/dsh-user/workspaces' }),
      envelope('host.listDirectory', { path: '/dsh-user/workspaces/project-a' }),
      envelope('host.createDirectory', {
        path: '/dsh-user/workspaces',
        name: 'project-b',
      }),
    ]);
  });

  it('rejects every other DSH settings or credential operation before locating a runner', async () => {
    const fixture = createFixture();
    let located = 0;
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: {
        ensure: async () => {
          located += 1;
          return fixedRunner();
        },
      },
      runnerIdentitySecret: Buffer.alloc(32, 4),
    });
    const headers = { cookie: `company_session=${fixture.token}` };
    const deniedRequests = [
      ['settings.update', {}],
      ['settings.replace', {}],
      ['settings.openDocument', {}],
      ['credentials.describe', {}],
      ['credentials.set', {}],
      ['host.listDirectory', { path: '/dsh-user' }],
      ['host.listDirectory', { path: '/dsh-user/workspaces/../.company' }],
      ['host.createDirectory', { path: '/dsh-user/workspaces', name: '../escape' }],
      [
        'settings.mutate',
        {
          ns: 'models',
          ops: [{ op: 'set', path: ['providers'], value: {} }],
        },
      ],
      [
        'settings.mutate',
        {
          ns: 'ui-onboarding',
          ops: [{ op: 'set', path: ['anotherField'], value: 'ignored' }],
        },
      ],
      [
        'settings.mutate',
        {
          ns: 'ui-onboarding',
          ops: [{ op: 'unset', path: ['welcomeNoticeVersion'] }],
        },
      ],
    ] as const;

    for (const [method, payload] of deniedRequests) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: `/chat/api/${method}`,
        headers,
        payload: envelope(method, payload),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('dsh_method_denied');
    }
    expect(located).toBe(0);
  });

  it('proxies the read-only Cordis bootstrap namespace without opening other methods', async () => {
    const fixture = createFixture();
    const upstreamUrls: string[] = [];
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: fixedRunnerLocator(),
      runnerIdentitySecret: Buffer.alloc(32, 4),
      fetch: async (url) => {
        upstreamUrls.push(String(url));
        return Response.json({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: true, value: [] },
        });
      },
    });

    for (const method of [
      'dynamicCordisRunner/inventory',
      'dynamicCordisRunner/syncInspectManifest',
    ]) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: `/chat/api/${method}`,
        headers: { cookie: `company_session=${fixture.token}` },
        payload: envelope(method, {}),
      });
      expect(response.statusCode).toBe(200);
    }

    const denied = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/dynamicCordisRunner/invoke',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: envelope('dynamicCordisRunner/invoke', {}),
    });

    expect(denied.statusCode).toBe(403);
    expect(upstreamUrls).toEqual([
      'http://runner-a:3000/api/dynamicCordisRunner/inventory',
      'http://runner-a:3000/api/dynamicCordisRunner/syncInspectManifest',
    ]);
  });

  it('opens the official Web with an unconfigured runner before model setup', async () => {
    const fixture = createFixture();
    fixture.repository.modelConfigs.delete(userAId);
    const preparedUsers: string[] = [];
    const ensuredVersions: number[] = [];
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: {
        ensure: async (input) => {
          ensuredVersions.push(input.configVersion);
          return fixedRunner();
        },
      },
      runnerIdentitySecret: Buffer.alloc(32, 4),
      prepareUnconfiguredRunner: async (user) => {
        preparedUsers.push(user.id);
        return 1;
      },
      fetch: async () =>
        new Response('<!doctype html><title>Company DSH</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    });

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/chat',
      headers: { cookie: `company_session=${fixture.token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Company DSH');
    expect(preparedUsers).toEqual([userAId]);
    expect(ensuredVersions).toEqual([1]);
  });

  it('prepares the aggregate Runner version for an already configured user', async () => {
    const fixture = createFixture();
    const preparedModels: Array<ModelConfigRecord | null> = [];
    const ensuredVersions: number[] = [];
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: {
        ensure: async (input) => {
          ensuredVersions.push(input.configVersion);
          return fixedRunner();
        },
      },
      runnerIdentitySecret: Buffer.alloc(32, 4),
      prepareRunner: async (_user, model) => {
        preparedModels.push(model);
        return 7;
      },
      fetch: async () =>
        new Response('<!doctype html><title>Company DSH</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    });

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/chat',
      headers: { cookie: `company_session=${fixture.token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(preparedModels).toHaveLength(1);
    expect(preparedModels[0]?.configVersion).toBe(1);
    expect(ensuredVersions).toEqual([7]);
  });

  it('strips the public chat prefix when proxying DSH static and plugin assets', async () => {
    const fixture = createFixture();
    const upstreamUrls: string[] = [];
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: fixedRunnerLocator(),
      runnerIdentitySecret: Buffer.alloc(32, 4),
      fetch: async (url) => {
        upstreamUrls.push(String(url));
        return new Response('asset', { headers: { 'content-type': 'text/javascript' } });
      },
    });

    const headers = { cookie: `company_session=${fixture.token}` };
    expect(
      (
        await fixture.app.inject({
          method: 'GET',
          url: '/chat/assets/app.js?rev=one',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await fixture.app.inject({
          method: 'GET',
          url: '/chat/plugins/@deepseek-ai/example/client.js?rev=two',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(upstreamUrls).toEqual([
      'http://runner-a:3000/assets/app.js?rev=one',
      'http://runner-a:3000/plugins/@deepseek-ai/example/client.js?rev=two',
    ]);
  });

  it('forwards only well-formed client responses to the isolated user runner', async () => {
    const fixture = createFixture();
    const upstreamBodies: unknown[] = [];
    let located = 0;
    registerDshGateway(fixture.app, {
      repository: fixture.repository,
      runnerLocator: {
        ensure: async () => {
          located += 1;
          return fixedRunner();
        },
      },
      runnerIdentitySecret: Buffer.alloc(32, 5),
      fetch: async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({ accepted: true });
      },
    });
    const malformed = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/respond',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: { type: 'client-request', rpcId: 'rpc-1', result: { ok: true } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(located).toBe(0);

    const body = {
      type: 'client-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { outcome: 'rejected' } },
    };
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/chat/api/respond',
      headers: { cookie: `company_session=${fixture.token}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(located).toBe(1);
    expect(upstreamBodies).toEqual([body]);
  });
});

function fixedRunnerLocator(): DshRunnerLocator {
  return { ensure: async () => fixedRunner() };
}

function fixedRunner() {
  return { runnerId: randomUUID(), internalEndpoint: 'http://runner-a:3000' };
}

function createFixture() {
  const repository = new MemoryPlatformRepository(tenantId);
  const user = userRecord(userAId, 'dev_a');
  repository.users.set(user.id, user);
  repository.users.set(userBId, userRecord(userBId, 'dev_b'));
  repository.modelConfigs.set(user.id, modelConfig(user.id));
  const session = createSessionRecord(user.id);
  repository.webSessions.set(session.record.id, session.record as WebSessionRecord);
  const app = buildControlPlane({
    repository,
    secretCipher: new SecretCipher(Buffer.alloc(32, 9)),
  });
  apps.push(app);
  return { app, repository, token: session.token };
}

function userRecord(id: string, username: string): UserRecord {
  const now = new Date();
  return {
    id,
    tenantId,
    username,
    displayName: username,
    platformRole: 'member',
    status: 'active',
    version: 1,
    passwordHash: 'unused',
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
  };
}

function modelConfig(userId: string): ModelConfigRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    userId,
    baseUrl: 'https://model.example/v1',
    model: 'fixture-model',
    models: ['fixture-model'],
    temperature: 0.7,
    maxOutputTokens: null,
    apiKeyCiphertext: null,
    apiKeyHint: null,
    configVersion: 1,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function envelope(method: string, payload: Record<string, unknown>) {
  return { type: 'client-request', rpcId: 'rpc-1', method, payload };
}
