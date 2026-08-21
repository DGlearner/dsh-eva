import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { afterAll, describe, expect, it } from 'vitest';

import { buildControlPlane } from './app.js';
import type { UserRecord } from './domain.js';
import { registerDshGateway } from './gateway.js';
import { MemoryPlatformRepository } from './memory-repository.js';
import { SecretCipher } from './security.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const repository = new MemoryPlatformRepository(tenantId);
const materialized: Array<{ userId: string; apiKey: string | null }> = [];
const stoppedUsers: string[] = [];
const app = buildControlPlane({
  repository,
  secretCipher: new SecretCipher(Buffer.alloc(32, 7)),
  validateModelUrl: async (value) => new URL(value),
  configMaterializer: {
    stage: async (input) => {
      materialized.push({ userId: input.userId, apiKey: input.apiKey });
      return {
        stageId: input.stageId,
        userId: input.userId,
        configVersion: input.config.configVersion,
      };
    },
    activate: async () => undefined,
    rollback: async () => undefined,
  },
  runnerAdminClient: {
    list: async () => [],
    stop: async () => ({ operation_id: randomUUID(), status: 'accepted' }),
    stopForUser: async (id) => {
      stoppedUsers.push(id);
    },
  },
});

let runnerGeneration = 0;
registerDshGateway(app, {
  repository,
  runnerIdentitySecret: Buffer.alloc(32, 8),
  runnerLocator: {
    ensure: async () => ({
      runnerId: `00000000-0000-4000-8000-${String(++runnerGeneration).padStart(12, '0')}`,
      internalEndpoint: 'http://runner-user-a:3000',
    }),
  },
  fetch: async (_url, init) => {
    const envelope = JSON.parse(String(init?.body)) as { rpcId: string; method: string };
    const value =
      envelope.method === 'session.create'
        ? { sessionId: 'session-wave-1' }
        : envelope.method === 'session.list'
          ? { items: [{ sessionId: 'session-wave-1', updatedAt: Date.now() }] }
          : { accepted: true };
    return Response.json({
      type: 'server-response',
      rpcId: envelope.rpcId,
      result: { ok: true, value },
    });
  },
});

afterAll(async () => app.close());

describe('Wave 1 primary path', () => {
  it('logs in, configures a model, creates a Session, chats, and reconciles history', async () => {
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
    const login = await app.inject({
      method: 'POST',
      url: '/company-api/v1/auth/login',
      payload: { username: 'dev_a', password: 'password-123' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieHeader(login.headers['set-cookie']);
    const csrf = login.json().csrf_token as string;

    const configured = await app.inject({
      method: 'PUT',
      url: '/company-api/v1/model-config',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        base_url: 'https://model.example/v1',
        model: 'fixture-model',
        temperature: 0.7,
        max_output_tokens: 2048,
        api_key: 'fixture-key-not-real',
        expected_version: 0,
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ has_api_key: true, api_key_hint: '****real' });
    expect(materialized).toEqual([{ userId, apiKey: 'fixture-key-not-real' }]);
    expect(stoppedUsers).toEqual([userId]);

    const created = await rpc(cookie, 'session.create', {});
    expect(created.statusCode).toBe(200);
    expect(await repository.getSession(userId, 'session-wave-1')).not.toBeNull();

    const prompt = await rpc(cookie, 'session.prompt', {
      sessionId: 'session-wave-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(prompt.statusCode).toBe(200);

    const reconciled = await rpc(cookie, 'session.list', {});
    expect(reconciled.statusCode).toBe(200);
    expect(repository.sessions.size).toBe(1);
    expect(runnerGeneration).toBeGreaterThanOrEqual(3);
  });
});

async function rpc(cookie: string, method: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/chat/api/${method}`,
    headers: { cookie },
    payload: { type: 'client-request', rpcId: randomUUID(), method, payload },
  });
}

function cookieHeader(value: string | string[] | undefined): string {
  const lines = Array.isArray(value) ? value : value ? [value] : [];
  return lines.map((line) => line.split(';', 1)[0]).join('; ');
}
