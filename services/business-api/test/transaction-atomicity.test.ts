import { afterEach, describe, expect, it } from 'vitest';

import { actors, authHeaders, createTestContext } from './helpers.js';

const contexts: ReturnType<typeof createTestContext>[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ app }) => app.close()));
});

const taskId = '00000000-0000-4000-8000-000000004002';

describe('Business command transaction atomicity', () => {
  it('allows only one submission for different keys racing on the same old version', async () => {
    const context = createTestContext();
    contexts.push(context);
    const beforeSubmissions = await context.repository.listTaskSubmissions(taskId);
    const requests = await Promise.all(
      ['submission-race-a', 'submission-race-b'].map(async (key, index) =>
        context.app.inject({
          method: 'POST',
          url: `/company-api/v1/tasks/${taskId}/submissions`,
          headers: await authHeaders(actors.devA, { 'idempotency-key': key }),
          payload: {
            summary: `并发提交 ${index + 1}`,
            evidence: [{ kind: 'text', label: '测试', value: `evidence-${index + 1}` }],
            expected_version: 3,
          },
        }),
      ),
    );

    expect(requests.map((response) => response.statusCode).sort()).toEqual([201, 412]);
    expect(await context.repository.listTaskSubmissions(taskId)).toHaveLength(
      beforeSubmissions.length + 1,
    );
    expect(await context.repository.listTaskStatusHistory(taskId)).toHaveLength(1);
    expect(await context.repository.getTask(actors.devA.tenantId, taskId)).toMatchObject({
      status: 'review',
      version: 4,
    });
    const records = await Promise.all(
      ['submission-race-a', 'submission-race-b'].map((key) =>
        context.repository.getIdempotencyRecord(
          actors.devA.tenantId,
          actors.devA.userId,
          `POST /tasks/${taskId}/submissions`,
          key,
        ),
      ),
    );
    expect(records.filter((record) => record !== null)).toHaveLength(1);
  });

  it('rolls back submission, task, history, audit, and idempotency when audit fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    context.repository.failNext('addAuditEvent');
    const key = 'submission-audit-failure';
    const failed = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${taskId}/submissions`,
      headers: await authHeaders(actors.devA, { 'idempotency-key': key }),
      payload: {
        summary: '应整体回滚',
        evidence: [{ kind: 'text', label: '测试', value: 'rollback' }],
        expected_version: 3,
      },
    });

    expect(failed.statusCode).toBe(500);
    expect(await context.repository.listTaskSubmissions(taskId)).toHaveLength(0);
    expect(await context.repository.listTaskStatusHistory(taskId)).toHaveLength(0);
    expect(await context.repository.listAuditEvents(actors.devA.tenantId)).toHaveLength(0);
    expect(await context.repository.getTask(actors.devA.tenantId, taskId)).toMatchObject({
      status: 'in_progress',
      version: 3,
    });
    expect(
      await context.repository.getIdempotencyRecord(
        actors.devA.tenantId,
        actors.devA.userId,
        `POST /tasks/${taskId}/submissions`,
        key,
      ),
    ).toBeNull();
  });

  it('rolls back a task transition when history persistence fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    const todoTaskId = '00000000-0000-4000-8000-000000004004';
    context.repository.failNext('addTaskStatusHistory');
    const failed = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${todoTaskId}/transitions`,
      headers: await authHeaders(actors.devB, { 'idempotency-key': 'history-failure' }),
      payload: { to_status: 'in_progress', expected_version: 1, reason: null },
    });

    expect(failed.statusCode).toBe(500);
    expect(await context.repository.getTask(actors.devB.tenantId, todoTaskId)).toMatchObject({
      status: 'todo',
      version: 1,
    });
    expect(await context.repository.listTaskStatusHistory(todoTaskId)).toHaveLength(0);
    expect(await context.repository.listAuditEvents(actors.devB.tenantId)).toHaveLength(0);
  });

  it('rolls back a daily report when revision persistence fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    context.repository.failNext('addDailyReportRevision');
    const failed = await context.app.inject({
      method: 'PUT',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers: await authHeaders(actors.devA),
      payload: {
        content: {
          completed_today: '事务测试',
          next_plan: '验证回滚',
          blockers: '无',
          other: '无',
          free_text: null,
        },
        expected_version: 0,
      },
    });

    expect(failed.statusCode).toBe(500);
    expect(
      await context.repository.getDailyReport(
        actors.devA.tenantId,
        actors.devA.userId,
        '2026-08-19',
      ),
    ).toBeNull();
  });

  it('rolls back a created requirement when idempotency persistence fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    const key = 'idempotency-write-failure';
    const payload = {
      title: '不应残留的需求',
      objective: '幂等结果失败时回滚。',
      acceptance_criteria: ['无半完成数据'],
    };
    context.repository.failNext('putIdempotencyRecord');
    const failed = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: await authHeaders(actors.manager, { 'idempotency-key': key }),
      payload,
    });

    expect(failed.statusCode).toBe(500);
    expect(
      (await context.repository.listRequirements(actors.manager.tenantId)).filter(
        (requirement) => requirement.title === payload.title,
      ),
    ).toHaveLength(0);
    const retried = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: await authHeaders(actors.manager, { 'idempotency-key': key }),
      payload,
    });
    expect(retried.statusCode).toBe(201);
  });

  it('rolls back requirement, tasks, and history when publish audit fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    const requirementId = '00000000-0000-4000-8000-000000003001';
    const planningTaskId = '10000000-0000-4000-8000-000000009001';
    await context.repository.createTasks(
      [
        {
          id: planningTaskId,
          requirement_id: requirementId,
          parent_task_id: null,
          department_id: actors.manager.departmentId!,
          assignee_user_id: actors.devA.userId,
          title: '发布回滚任务',
          description: '发布失败时仍应处于 planning。',
          acceptance_criteria: [],
          status: 'planning',
          position: 1,
          due_at: null,
          latest_review_result: null,
          version: 1,
          created_at: '2026-08-18T10:00:00.000Z',
          updated_at: '2026-08-18T10:00:00.000Z',
        },
      ],
      [],
    );
    context.repository.failNext('addAuditEvent');
    const failed = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirementId}/publish`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'publish-audit-failure' }),
      payload: { expected_version: 2 },
    });

    expect(failed.statusCode).toBe(500);
    expect(
      await context.repository.getRequirement(actors.manager.tenantId, requirementId),
    ).toMatchObject({ status: 'draft', version: 2 });
    expect(await context.repository.getTask(actors.manager.tenantId, planningTaskId)).toMatchObject(
      {
        status: 'planning',
        version: 1,
      },
    );
    expect(await context.repository.listTaskStatusHistory(planningTaskId)).toHaveLength(0);
  });

  it('rolls back knowledge mutation and idempotency when archive audit fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    const documentId = '00000000-0000-4000-8000-000000002001';
    const key = 'knowledge-archive-audit-failure';
    context.repository.failNext('addAuditEvent');
    const failed = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/knowledge/documents/${documentId}/archive`,
      headers: await authHeaders(actors.admin, { 'idempotency-key': key }),
      payload: { expected_version: 1, reason: 'rollback test' },
    });

    expect(failed.statusCode).toBe(500);
    expect(
      await context.repository.getKnowledgeDocument(actors.admin.tenantId, documentId),
    ).toMatchObject({ status: 'ready', version: 1 });
    expect(
      await context.repository.getIdempotencyRecord(
        actors.admin.tenantId,
        actors.admin.userId,
        `POST /knowledge/documents/${documentId}/archive`,
        key,
      ),
    ).toBeNull();
  });

  it('rolls back the losing concurrent split without duplicate tasks', async () => {
    const context = createTestContext();
    contexts.push(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'split-race-create' }),
      payload: {
        title: '并发拆分',
        objective: '只允许一个旧版本应用成功。',
        acceptance_criteria: ['无重复任务'],
      },
    });
    const requirement = created.json();
    const split = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirement.id}/split-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'split-race-preview' }),
      payload: { expected_version: 1 },
    });
    for (let index = 0; index < 2; index += 1) {
      await context.app.inject({
        method: 'GET',
        url: `/company-api/v1/automation-operations/${split.json().id}`,
        headers: await authHeaders(actors.manager),
      });
    }
    const operation = await context.repository.getAutomationOperation(
      actors.manager.tenantId,
      split.json().id,
    );
    if (operation === null || operation.result === null) {
      throw new Error('Split operation result is missing.');
    }
    const payload = {
      operation_id: split.json().id,
      tasks: (operation.result as { tasks: unknown[] }).tasks,
      expected_version: 1,
    };
    const responses = await Promise.all(
      ['split-race-apply-a', 'split-race-apply-b'].map(async (key) =>
        context.app.inject({
          method: 'POST',
          url: `/company-api/v1/requirements/${requirement.id}/apply-split`,
          headers: await authHeaders(actors.manager, { 'idempotency-key': key }),
          payload,
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 412]);
    const tasks = (await context.repository.listTasks(actors.manager.tenantId)).filter(
      (task) => task.requirement_id === requirement.id,
    );
    expect(tasks).toHaveLength(payload.tasks.length);
    expect(
      await context.repository.getRequirement(actors.manager.tenantId, requirement.id),
    ).toMatchObject({
      version: 2,
    });
  });

  it('recovers automation starts using the provider idempotency key', async () => {
    const context = createTestContext();
    contexts.push(context);
    const requirementId = '00000000-0000-4000-8000-000000003001';

    context.automation.failNextStart();
    const providerFailed = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirementId}/split-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'provider-start-retry' }),
      payload: { expected_version: 2 },
    });
    expect(providerFailed.statusCode).toBe(500);
    expect(context.automation.getRunCount()).toBe(0);
    const providerRecovered = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirementId}/split-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'provider-start-retry' }),
      payload: { expected_version: 2 },
    });
    expect(providerRecovered.statusCode).toBe(202);
    expect(context.automation.getRunCount()).toBe(1);

    context.repository.failNext('createAutomationOperation');
    const localFailed = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirementId}/split-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'local-operation-retry' }),
      payload: { expected_version: 2 },
    });
    expect(localFailed.statusCode).toBe(500);
    expect(context.automation.getRunCount()).toBe(2);
    const localRecovered = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/requirements/${requirementId}/split-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'local-operation-retry' }),
      payload: { expected_version: 2 },
    });
    expect(localRecovered.statusCode).toBe(202);
    expect(context.automation.getRunCount()).toBe(2);
  });

  it('rolls back and retries an atomic automation review-result apply', async () => {
    const context = createTestContext();
    contexts.push(context);
    const reviewTaskId = '00000000-0000-4000-8000-000000004003';
    const started = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/tasks/${reviewTaskId}/review-runs`,
      headers: await authHeaders(actors.manager, { 'idempotency-key': 'review-apply-rollback' }),
      payload: {
        submission_id: '00000000-0000-4000-8000-000000004902',
        expected_version: 4,
      },
    });
    await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/automation-operations/${started.json().id}`,
      headers: await authHeaders(actors.manager),
    });
    context.repository.failNext('saveTask');
    const failed = await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/automation-operations/${started.json().id}`,
      headers: await authHeaders(actors.manager),
    });

    expect(failed.statusCode).toBe(500);
    expect(
      await context.repository.getAutomationOperation(actors.manager.tenantId, started.json().id),
    ).toMatchObject({ status: 'running', version: 2 });
    expect(await context.repository.getTask(actors.manager.tenantId, reviewTaskId)).toMatchObject({
      latest_review_result: 'needs_review',
      version: 4,
    });

    const recovered = await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/automation-operations/${started.json().id}`,
      headers: await authHeaders(actors.manager),
    });
    expect(recovered.json().status).toBe('succeeded');
    expect(await context.repository.getTask(actors.manager.tenantId, reviewTaskId)).toMatchObject({
      latest_review_result: 'pass',
      status: 'review',
      version: 5,
    });
  });

  it('rolls back document completion when upload status persistence fails', async () => {
    const context = createTestContext();
    contexts.push(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/knowledge/uploads',
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'upload-status-rollback' }),
      payload: {
        scope: 'personal',
        category: null,
        title: '上传事务回滚',
        file_name: 'rollback.md',
        media_type: 'text/markdown',
        size_bytes: 10,
        scenario: 'success',
      },
    });
    const uploadId = created.json().id;
    const upload = await context.repository.getKnowledgeUpload(actors.devA.tenantId, uploadId);
    const poll = async () =>
      context.app.inject({
        method: 'GET',
        url: `/company-api/v1/knowledge/uploads/${uploadId}`,
        headers: await authHeaders(actors.devA),
      });
    await poll();
    await poll();
    context.repository.failNext('saveKnowledgeUpload');
    expect((await poll()).statusCode).toBe(500);
    expect(
      await context.repository.getKnowledgeDocument(actors.devA.tenantId, upload!.document_id),
    ).toMatchObject({ status: 'pending_review', version: 1 });
    expect(
      await context.repository.getKnowledgeUpload(actors.devA.tenantId, uploadId),
    ).toMatchObject({ status: 'running', progress: 80, version: 3 });
    expect((await poll()).json()).toMatchObject({ status: 'succeeded', progress: 100 });
  });
});
