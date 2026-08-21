import { afterEach, describe, expect, it } from 'vitest';

import { actors, authHeaders, createTestContext } from './helpers.js';

const contexts: ReturnType<typeof createTestContext>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ app }) => app.close()));
});

describe('Requirements and Tasks API', () => {
  it('does not create a requirement twice for the same idempotency key', async () => {
    const context = createTestContext();
    contexts.push(context);
    const headers = await authHeaders(actors.manager, {
      'idempotency-key': 'requirement-create-001',
    });
    const payload = {
      title: '幂等需求',
      objective: '验证重复请求不会创建两条记录。',
      acceptance_criteria: ['相同 key 返回相同 id'],
    };
    const [first, second] = await Promise.all([
      context.app.inject({
        method: 'POST',
        url: '/company-api/v1/requirements',
        headers,
        payload,
      }),
      context.app.inject({
        method: 'POST',
        url: '/company-api/v1/requirements',
        headers,
        payload,
      }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    const conflict = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers,
      payload: { ...payload, title: '同 key 不同请求' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency_key_reused');
    const all = await context.repository.listRequirements(actors.manager.tenantId);
    expect(all.filter((item) => item.title === payload.title)).toHaveLength(1);
  });

  it('allows an expired idempotency key to start a new request window', async () => {
    const context = createTestContext();
    contexts.push(context);
    const key = 'expired-requirement-create-001';
    await context.repository.putIdempotencyRecord({
      tenant_id: actors.manager.tenantId,
      actor_user_id: actors.manager.userId,
      route: 'POST /requirements',
      key,
      request_hash: 'expired-request-hash',
      status_code: 201,
      response_json: { id: 'expired-response' },
      expires_at: '2026-08-18T09:59:59.000Z',
    });
    const headers = await authHeaders(actors.manager, { 'idempotency-key': key });
    const payload = {
      title: '过期幂等键复用',
      objective: '验证过期记录可被新请求覆盖。',
      acceptance_criteria: ['后续重放返回新响应'],
    };
    const first = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers,
      payload,
    });
    const replay = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(first.json().id).not.toBe('expired-response');
    expect(replay.json()).toEqual(first.json());
    const all = await context.repository.listRequirements(actors.manager.tenantId);
    expect(all.filter((item) => item.title === payload.title)).toHaveLength(1);
  });

  it('replays split apply and publish without duplicating tasks', async () => {
    const context = createTestContext();
    contexts.push(context);
    const create = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'flow-create-001' }),
      payload: {
        title: '发布链路',
        objective: '完成拆分和发布。',
        acceptance_criteria: ['任务进入 todo'],
      },
    });
    const requirement = create.json();
    const split = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirement.id}/split-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'flow-split-001' }),
      payload: { expected_version: 1 },
    });
    const operationId = split.json().id;
    const poll = async () =>
      context.app.inject({
        method: 'GET',
        url: `/company-api/v1/automation-operations/${operationId}`,
        headers: await authHeaders(actors.manager),
      });
    expect((await poll()).json().status).toBe('running');
    const completed = await poll();
    expect(completed.json().status).toBe('succeeded');
    const tasks = completed.json().result.tasks;

    const applyHeaders = await authHeaders(actors.manager, {
      'idempotency-key': 'flow-apply-001',
    });
    const applyBody = { operation_id: operationId, tasks, expected_version: 1 };
    const applied = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirement.id}/apply-split`,
      headers: applyHeaders,
      payload: applyBody,
    });
    const appliedReplay = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirement.id}/apply-split`,
      headers: applyHeaders,
      payload: applyBody,
    });
    expect(applied.statusCode).toBe(200);
    expect(appliedReplay.json().tasks).toHaveLength(1);

    const publishHeaders = await authHeaders(actors.manager, {
      'idempotency-key': 'flow-publish-001',
    });
    const published = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirement.id}/publish`,
      headers: publishHeaders,
      payload: { expected_version: 2 },
    });
    const replay = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirement.id}/publish`,
      headers: publishHeaders,
      payload: { expected_version: 2 },
    });
    expect(published.json()).toEqual(replay.json());
    expect(replay.json().tasks).toHaveLength(1);
    expect(replay.json().tasks[0].status).toBe('todo');
    const audits = await context.repository.listAuditEvents(actors.manager.tenantId);
    expect(audits.filter((event) => event.action === 'requirement.published')).toHaveLength(1);
  });

  it('does not duplicate a task submission and moves the task to review once', async () => {
    const context = createTestContext();
    contexts.push(context);
    const taskId = '00000000-0000-4000-8000-000000004002';
    const headers = await authHeaders(actors.devA, { 'idempotency-key': 'submission-key-001' });
    const payload = {
      summary: '任务列表已完成。',
      evidence: [{ kind: 'text', label: '测试', value: '四个视图通过。' }],
      expected_version: 3,
    };
    const first = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${taskId}/submissions`,
      headers,
      payload,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${taskId}/submissions`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/tasks/${taskId}`,
      headers: await authHeaders(actors.devA),
    });
    expect(detail.json().status).toBe('review');
    expect(detail.json().submissions).toHaveLength(1);
    const audits = await context.repository.listAuditEvents(actors.devA.tenantId);
    expect(audits.filter((event) => event.action === 'task.submitted')).toHaveLength(1);
  });

  it('prevents cross-user, cross-department, and platform-admin privilege escalation', async () => {
    const context = createTestContext();
    contexts.push(context);
    const taskId = '00000000-0000-4000-8000-000000004002';
    for (const actor of [actors.devB, actors.productManager, actors.admin]) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/company-api/v1/tasks/${taskId}`,
        headers: await authHeaders(actor),
      });
      expect(response.statusCode).toBe(404);
    }
    const memberCreate = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'member-create-denied' }),
      payload: { title: '越权', objective: '越权', acceptance_criteria: [] },
    });
    expect(memberCreate.statusCode).toBe(403);
  });

  it('records automatic review output but keeps the task in review until manager acceptance', async () => {
    const context = createTestContext();
    contexts.push(context);
    const taskId = '00000000-0000-4000-8000-000000004003';
    const started = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${taskId}/review-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'review-start-001' }),
      payload: {
        submission_id: '00000000-0000-4000-8000-000000004902',
        expected_version: 4,
      },
    });
    expect(started.statusCode).toBe(202);
    const operationId = started.json().id;
    for (let index = 0; index < 2; index += 1) {
      await context.app.inject({
        method: 'GET',
        url: `/company-api/v1/automation-operations/${operationId}`,
        headers: await authHeaders(actors.manager),
      });
    }
    const detail = await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/tasks/${taskId}`,
      headers: await authHeaders(actors.manager),
    });
    expect(detail.json().latest_review_result).toBe('pass');
    expect(detail.json().status).toBe('review');
    expect(detail.json().review_runs.at(-1)).toMatchObject({
      status: 'succeeded',
      result: 'pass',
      executor_version: 'fake-automation-v1',
    });

    const accepted = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${taskId}/accept`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'review-accept-001' }),
      payload: { expected_version: detail.json().version, reason: '主管验收通过' },
    });
    expect(accepted.json().status).toBe('done');
  });
});
