import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildControlPlane } from './app.js';
import { StubAutomationExecutor } from './automation.js';
import { MemoryPlatformRepository } from './memory-repository.js';
import { SecretCipher } from './security.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorUserId = '00000000-0000-4000-8000-000000001003';
const serviceToken = 'automation-test-service-token';
const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('internal automation idempotency', () => {
  it('creates one run for concurrent equivalent requests and rejects key reuse', async () => {
    const stub = new StubAutomationExecutor();
    const create = vi.fn(stub.create.bind(stub));
    const app = buildControlPlane({
      repository: new MemoryPlatformRepository(tenantId),
      secretCipher: new SecretCipher(Buffer.alloc(32, 7)),
      serviceToken,
      automationExecutor: { create, get: stub.get.bind(stub) },
    });
    apps.push(app);
    const key = randomUUID();

    const [first, duplicate] = await Promise.all([
      createRun(app, key, automationBody()),
      createRun(app, key, automationBody()),
    ]);

    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual(first.json());
    expect(create).toHaveBeenCalledOnce();

    const reused = await createRun(app, key, { ...automationBody(), purpose: 'task_review' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('requires the contracted Idempotency-Key header', async () => {
    const app = buildControlPlane({
      repository: new MemoryPlatformRepository(tenantId),
      secretCipher: new SecretCipher(Buffer.alloc(32, 7)),
      serviceToken,
    });
    apps.push(app);

    const response = await createRun(app, undefined, automationBody());

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'idempotency_key_required' });
  });
});

function automationBody() {
  return {
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    purpose: 'task_split',
    correlation_id: '00000000-0000-4000-8000-000000006001',
    input: { title: 'Split this task' },
    output_schema_id: 'task_split.v1',
  };
}

function createRun(
  app: ReturnType<typeof buildControlPlane>,
  idempotencyKey: string | undefined,
  body: ReturnType<typeof automationBody>,
) {
  return app.inject({
    method: 'POST',
    url: '/internal/v1/automation-runs',
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'x-request-id': randomUUID(),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    payload: body,
  });
}
