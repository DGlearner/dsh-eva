import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildControlPlane } from './app.js';
import {
  DisabledAutomationExecutor,
  ModelAutomationExecutor,
  StubAutomationExecutor,
  createRuntimeAutomationExecutor,
} from './automation.js';
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
  it('defaults production to disabled and rejects a production stub', () => {
    expect(createRuntimeAutomationExecutor(undefined, 'production')).toBeInstanceOf(
      DisabledAutomationExecutor,
    );
    expect(() => createRuntimeAutomationExecutor('stub', 'production')).toThrow(
      /forbidden in production/,
    );
    expect(createRuntimeAutomationExecutor(undefined, 'development')).toBeInstanceOf(
      StubAutomationExecutor,
    );
  });

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

describe('model automation executor', () => {
  it('rewrites a daily report with the actor model configuration without a Runner', async () => {
    const { executor, fetchImpl } = configuredModelExecutor({
      content: {
        completed_today: '',
        next_plan: '',
        blockers: '',
        other: '',
        free_text: '今天完成了接口联调，明天继续验证异常场景。',
      },
    });

    const created = await executor.create(dailyRewriteRequest());
    const completed = await waitForTerminalRun(executor, created.id);

    expect(completed).toMatchObject({
      status: 'succeeded',
      output: {
        content: { free_text: '今天完成了接口联调，明天继续验证异常场景。' },
      },
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(input.toString()).toBe('https://model.example/v1/chat/completions');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-model-key' });
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'deepseek-chat',
      temperature: 0.4,
      max_tokens: 800,
    });
  });

  it('keeps task-review evidence server-bound instead of trusting model evidence', async () => {
    const { executor } = configuredModelExecutor({
      result: 'pass',
      summary: '检查通过。',
      checks: [{ name: '测试', passed: true, detail: '已提供测试证据。' }],
      evidence: [{ kind: 'url', label: '模型伪造', value: 'https://untrusted.example' }],
    });
    const inputEvidence = [{ kind: 'text', label: '测试结果', value: '12 tests passed' }];
    const created = await executor.create({
      tenant_id: tenantId,
      actor_user_id: actorUserId,
      purpose: 'task_review',
      correlation_id: '00000000-0000-4000-8000-000000006003',
      input: {
        task: { title: '完成接口', acceptance_criteria: ['测试通过'] },
        summary: '接口与测试已完成。',
        evidence: inputEvidence,
      },
      output_schema_id: 'company.task-review.v1',
    });

    const completed = await waitForTerminalRun(executor, created.id);

    expect(completed).toMatchObject({
      status: 'succeeded',
      output: {
        result: 'pass',
        evidence: inputEvidence,
        executor_version: 'direct-model-v1',
      },
    });
  });

  it('fails cleanly when the actor has no model configuration', async () => {
    const repository = new MemoryPlatformRepository(tenantId);
    const executor = new ModelAutomationExecutor({
      repository,
      secretCipher: new SecretCipher(Buffer.alloc(32, 9)),
      validateModelUrl: async (value) => new URL(value),
      fetchImpl: vi.fn(),
    });

    const created = await executor.create(dailyRewriteRequest());
    const completed = await waitForTerminalRun(executor, created.id);

    expect(completed).toMatchObject({
      status: 'failed',
      output: null,
      error: { code: 'model_config_required' },
    });
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

function dailyRewriteRequest() {
  return {
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    purpose: 'daily_rewrite' as const,
    correlation_id: '00000000-0000-4000-8000-000000006002',
    input: {
      mode: 'polish',
      content: {
        completed_today: '',
        next_plan: '',
        blockers: '',
        other: '',
        free_text: '今天搞完接口，明天测异常。',
      },
    },
    output_schema_id: 'company.daily-rewrite.v1',
  };
}

async function waitForTerminalRun(executor: ModelAutomationExecutor, runId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const run = await executor.get(runId);
    if (run?.status === 'succeeded' || run?.status === 'failed') return run;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('model automation did not complete');
}

function configuredModelExecutor(output: Record<string, unknown>) {
  const repository = new MemoryPlatformRepository(tenantId);
  const secretCipher = new SecretCipher(Buffer.alloc(32, 9));
  repository.modelConfigs.set(actorUserId, {
    id: randomUUID(),
    userId: actorUserId,
    baseUrl: 'https://model.example/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat'],
    temperature: 0.4,
    maxOutputTokens: 800,
    apiKeyCiphertext: secretCipher.seal('secret-model-key'),
    apiKeyHint: '****-key',
    configVersion: 1,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }),
  );
  return {
    fetchImpl,
    executor: new ModelAutomationExecutor({
      repository,
      secretCipher,
      validateModelUrl: async (value) => new URL(value),
      fetchImpl,
    }),
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
