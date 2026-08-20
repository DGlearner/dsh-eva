import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';
import type { Schema } from '../api';
import {
  actor,
  fixture,
  getModelConfig,
  me,
  nextUuid,
  requirementDetail,
  saveModelConfig,
  setActiveUsername,
  taskDetail,
  userAdminViews,
} from './store';

const base = '/company-api/v1';

type AutomationOperation = Schema<'AutomationOperation'>;
type RuntimeOperation = {
  operation: AutomationOperation;
  finalOperation: AutomationOperation;
  polls: number;
  completed: boolean;
  taskContext?: { taskId: string; submissionId: string };
  reportContext?: { userId: string; workDate: string; changeBeforeCompletion: boolean };
};

const runtimeOperations = new Map<string, RuntimeOperation>();
let operationSequence = 0;

function problem(status: number, code: string, detail: string): HttpResponse<any> {
  return HttpResponse.json(
    {
      type: `urn:company-dsh:${code}`,
      title:
        status === 403 ? 'Forbidden' : status === 412 ? 'Precondition Failed' : 'Request Failed',
      status,
      detail,
      code,
      request_id: `msw-${code}`,
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function scenario(request: Request) {
  return request.headers.get('X-Mock-Scenario') ?? 'default';
}

function requestedActor(request: Request) {
  return request.headers.get('X-Mock-User');
}

async function guard(request: Request, options: { mutation?: boolean } = {}) {
  const state = scenario(request);
  await delay(state === 'loading' ? 8_000 : 90);
  if (options.mutation && request.headers.get('X-CSRF-Token') !== 'msw-csrf-token') {
    return problem(403, 'csrf_invalid', 'CSRF Token 无效，请刷新当前会话。');
  }
  if (state === 'error') return problem(500, 'fixture_error', '模拟服务暂时不可用。');
  if (state === 'forbidden') return problem(403, 'forbidden', '当前身份无权执行此操作。');
  if (state === 'conflict' && options.mutation) {
    return problem(412, 'version_conflict', '资源版本已更新，请重新获取最新内容。');
  }
  return null;
}

function current(request: Request) {
  return actor(requestedActor(request));
}

function empty(request: Request) {
  return scenario(request) === 'empty';
}

function page<T>(items: T[]) {
  return { items, next_cursor: null };
}

function mutableHandler(resolver: HttpResponseResolver<any, any, any>) {
  return resolver;
}

function operationTemplate(kind: AutomationOperation['kind'], resourceId?: string) {
  return (
    fixture.automation_operations.find(
      (item) => item.kind === kind && (!resourceId || item.resource_id === resourceId),
    ) ??
    fixture.automation_operations.find((item) => item.kind === kind) ??
    null
  );
}

function queueOperation(
  request: Request,
  template: AutomationOperation,
  taskContext?: RuntimeOperation['taskContext'],
  reportContext?: RuntimeOperation['reportContext'],
) {
  const terminalStatus =
    scenario(request) === 'failed'
      ? 'failed'
      : scenario(request) === 'cancelled'
        ? 'cancelled'
        : 'succeeded';
  const id = nextUuid(6900 + operationSequence);
  operationSequence += 1;
  const finalOperation: AutomationOperation = {
    id,
    kind: template.kind,
    status: terminalStatus,
    result: terminalStatus === 'succeeded' ? structuredClone(template.result) : null,
    error:
      terminalStatus === 'failed'
        ? { code: 'fixture_automation_failed', message: '自动化处理失败。' }
        : terminalStatus === 'cancelled'
          ? { code: 'fixture_automation_cancelled', message: '自动化操作已取消。' }
          : null,
    created_at: fixture.clock.now,
    completed_at: fixture.clock.now,
  };
  const operation: AutomationOperation = {
    ...finalOperation,
    status: 'queued',
    result: null,
    error: null,
    completed_at: null,
  };
  runtimeOperations.set(id, {
    operation,
    finalOperation,
    polls: 0,
    completed: false,
    taskContext,
    reportContext,
  });
  return operation;
}

function completeTaskReview(runtime: RuntimeOperation) {
  if (runtime.completed || runtime.finalOperation.status !== 'succeeded' || !runtime.taskContext)
    return;
  const result = runtime.finalOperation.result;
  if (!result || !('checks' in result)) return;
  const { taskId, submissionId } = runtime.taskContext;
  fixture.task_review_runs.push({
    id: nextUuid(5100 + fixture.task_review_runs.length),
    task_id: taskId,
    submission_id: submissionId,
    automation_run_id: runtime.finalOperation.id,
    status: 'succeeded',
    result: result.result,
    summary: result.summary,
    checks: result.checks,
    evidence: result.evidence,
    executor_version: result.executor_version,
    created_at: runtime.finalOperation.created_at,
    completed_at: runtime.finalOperation.completed_at,
  });
  const task = fixture.tasks.find((item) => item.id === taskId);
  if (task) {
    task.status = 'review';
    task.latest_review_result = result.result;
    task.version += 1;
    task.updated_at = fixture.clock.now;
  }
  runtime.completed = true;
}

function completeDailyReportChange(runtime: RuntimeOperation) {
  if (
    runtime.completed ||
    runtime.finalOperation.status !== 'succeeded' ||
    !runtime.reportContext?.changeBeforeCompletion
  )
    return;
  const report = fixture.daily_reports.find(
    (item) =>
      item.user_id === runtime.reportContext?.userId &&
      item.work_date === runtime.reportContext?.workDate,
  );
  if (report) {
    report.status = 'draft';
    report.version += 1;
    report.published_at = null;
    report.updated_at = fixture.clock.now;
  }
  runtime.completed = true;
}

export const handlers = [
  http.post(`${base}/auth/login`, async ({ request }) => {
    const state = scenario(request);
    await delay(state === 'loading' ? 8_000 : 140);
    if (state === 'forbidden')
      return problem(403, 'account_disabled', '账号已停用，请联系管理员。');
    const body = (await request.json()) as Schema<'LoginRequest'>;
    const user = fixture.users.find((item) => item.username === body.username);
    if (!user || body.password === 'invalid000') {
      return problem(401, 'invalid_credentials', '用户名或密码错误。');
    }
    setActiveUsername(user.username);
    return HttpResponse.json(me(user.username));
  }),
  http.post(`${base}/auth/logout`, () => {
    setActiveUsername(null);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${base}/me`, ({ request }) => {
    const context = me(requestedActor(request));
    return context ? HttpResponse.json(context) : problem(401, 'unauthorized', '请先登录。');
  }),
  http.get(`${base}/model-config`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const config = getModelConfig();
    return config
      ? HttpResponse.json(config)
      : problem(404, 'model_config_missing', '尚未配置模型。');
  }),
  http.put(`${base}/model-config`, async ({ request }) => {
    const blocked = await guard(request, { mutation: true });
    if (blocked) return blocked;
    const body = (await request.json()) as Schema<'UpdateModelConfigRequest'>;
    return HttpResponse.json(saveModelConfig(body));
  }),
  http.post(`${base}/model-config/test`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const body = (await request.json()) as Schema<'TestModelConfigRequest'>;
    const ok = !body.base_url.includes('invalid');
    return HttpResponse.json<Schema<'ModelConfigTestResult'>>({
      ok,
      latency_ms: ok ? 126 : 0,
      error_code: ok ? null : 'endpoint_unreachable',
    });
  }),
  http.get(`${base}/knowledge/categories`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (empty(request)) return HttpResponse.json([]);
    const scope = new URL(request.url).searchParams.get('scope');
    return HttpResponse.json(fixture.knowledge.categories.filter((item) => item.scope === scope));
  }),
  http.get(`${base}/knowledge/documents`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (empty(request)) return HttpResponse.json(page([]));
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    const category = url.searchParams.get('category');
    const status = url.searchParams.get('status');
    const user = current(request);
    const documents = fixture.knowledge.documents.filter(
      (item) =>
        item.scope === scope &&
        (scope === 'company' || item.owner_user_id === user?.id) &&
        (!category || item.category === category) &&
        (!status || item.status === status),
    );
    return HttpResponse.json(page(documents));
  }),
  http.post(`${base}/knowledge/uploads`, async ({ request }) => {
    const blocked = await guard(request, { mutation: true });
    if (blocked) return blocked;
    const body = (await request.json()) as Schema<'FakeKnowledgeUploadRequest'>;
    const user = current(request);
    const documentId = nextUuid(2800 + fixture.knowledge.documents.length);
    fixture.knowledge.documents.unshift({
      id: documentId,
      knowledge_id: `${body.scope}/upload/${documentId}`,
      scope: body.scope,
      owner_user_id: body.scope === 'personal' ? (user?.id ?? null) : null,
      category:
        body.scope === 'company'
          ? (body.category as Schema<'KnowledgeDocument'>['category'])
          : null,
      title: body.title,
      file_name: body.file_name,
      media_type: body.media_type,
      size_bytes: body.size_bytes,
      status: 'pending_review',
      version: 1,
      updated_at: fixture.clock.now,
    });
    const upload: Schema<'KnowledgeUpload'> & { owner_user_id: string } = {
      id: nextUuid(2900 + fixture.knowledge.uploads.length),
      document_id: documentId,
      owner_user_id: user?.id ?? '',
      status: body.scenario === 'fail' ? 'failed' : 'queued',
      progress: body.scenario === 'fail' ? 35 : 0,
      error_code: body.scenario === 'fail' ? 'fixture_parse_failed' : null,
      created_at: fixture.clock.now,
      updated_at: fixture.clock.now,
    };
    fixture.knowledge.uploads.unshift(upload);
    return HttpResponse.json(upload, { status: 202 });
  }),
  http.get(`${base}/knowledge/uploads/:uploadId`, async ({ request, params }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const upload = fixture.knowledge.uploads.find((item) => item.id === params.uploadId);
    return upload ? HttpResponse.json(upload) : problem(404, 'not_found', '未找到入库任务。');
  }),
  http.post(
    `${base}/knowledge/documents/:documentId/archive`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.knowledge.documents.find(
        (document) => document.id === params.documentId,
      );
      if (!item) return problem(404, 'not_found', '未找到文档。');
      item.status = 'archived';
      item.version += 1;
      return HttpResponse.json(item);
    }),
  ),
  http.post(
    `${base}/knowledge/documents/:documentId/restore`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.knowledge.documents.find(
        (document) => document.id === params.documentId,
      );
      if (!item) return problem(404, 'not_found', '未找到文档。');
      item.status = 'ready';
      item.version += 1;
      return HttpResponse.json(item);
    }),
  ),
  http.post(
    `${base}/knowledge/documents/:documentId/reindex`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.knowledge.documents.find(
        (document) => document.id === params.documentId,
      );
      if (!item) return problem(404, 'not_found', '未找到文档。');
      const upload: Schema<'KnowledgeUpload'> = {
        id: nextUuid(2950 + fixture.knowledge.uploads.length),
        document_id: item.id,
        status: 'queued',
        progress: 0,
        error_code: null,
        created_at: fixture.clock.now,
        updated_at: fixture.clock.now,
      };
      return HttpResponse.json(upload, { status: 202 });
    }),
  ),
  http.get(`${base}/requirements`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (empty(request)) return HttpResponse.json(page([]));
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const view = url.searchParams.get('view');
    const user = current(request);
    let items = fixture.requirements.filter((item) => !status || item.status === status);
    if (view === 'mine') items = items.filter((item) => item.publisher_user_id === user?.id);
    if (view === 'department') {
      const departmentId = me(user?.username)?.department?.id;
      items = items.filter((item) => item.department_id === departmentId);
    }
    return HttpResponse.json(page(items));
  }),
  http.post(`${base}/requirements`, async ({ request }) => {
    const blocked = await guard(request, { mutation: true });
    if (blocked) return blocked;
    const body = (await request.json()) as Schema<'CreateRequirementRequest'>;
    const user = current(request);
    const requirement: Schema<'Requirement'> = {
      ...body,
      id: nextUuid(3100 + fixture.requirements.length),
      department_id: me(user?.username)?.department?.id ?? fixture.departments[0]!.id,
      publisher_user_id: user?.id ?? fixture.users[0]!.id,
      status: 'draft',
      version: 1,
      created_at: fixture.clock.now,
      updated_at: fixture.clock.now,
      published_at: null,
    };
    fixture.requirements.unshift(requirement);
    return HttpResponse.json(requirement, { status: 201 });
  }),
  http.get(`${base}/requirements/:requirementId`, async ({ request, params }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const detail = requirementDetail(String(params.requirementId));
    return detail ? HttpResponse.json(detail) : problem(404, 'not_found', '未找到需求。');
  }),
  http.patch(
    `${base}/requirements/:requirementId`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.requirements.find(
        (requirement) => requirement.id === params.requirementId,
      );
      if (!item) return problem(404, 'not_found', '未找到需求。');
      const body = (await request.json()) as Schema<'UpdateRequirementRequest'>;
      Object.assign(item, body, { version: item.version + 1, updated_at: fixture.clock.now });
      return HttpResponse.json(item);
    }),
  ),
  http.post(
    `${base}/requirements/:requirementId/split-runs`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const operation = operationTemplate('requirement_split', String(params.requirementId));
      return operation
        ? HttpResponse.json(queueOperation(request, operation), { status: 202 })
        : problem(404, 'not_found', '没有可用的拆分预览。');
    }),
  ),
  http.post(
    `${base}/requirements/:requirementId/apply-split`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const body = (await request.json()) as Schema<'ApplySplitRequest'>;
      const requirement = fixture.requirements.find((item) => item.id === params.requirementId);
      if (!requirement) return problem(404, 'not_found', '未找到需求。');
      const operation = runtimeOperations.get(body.operation_id)?.operation;
      if (
        !operation ||
        operation.kind !== 'requirement_split' ||
        operation.status !== 'succeeded'
      ) {
        return problem(409, 'operation_not_ready', '拆分操作尚未成功完成。');
      }
      for (const draft of body.tasks) {
        fixture.tasks.push({
          id: nextUuid(4100 + fixture.tasks.length),
          requirement_id: requirement.id,
          parent_task_id: null,
          department_id: requirement.department_id,
          assignee_user_id: draft.assignee_user_id,
          title: draft.title,
          description: draft.description,
          acceptance_criteria: draft.acceptance_criteria,
          status: 'planning',
          due_at: null,
          latest_review_result: null,
          position: draft.position,
          version: 1,
          updated_at: fixture.clock.now,
        });
      }
      requirement.version += 1;
      return HttpResponse.json(requirementDetail(requirement.id));
    }),
  ),
  http.post(
    `${base}/requirements/:requirementId/publish`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.requirements.find(
        (requirement) => requirement.id === params.requirementId,
      );
      if (!item) return problem(404, 'not_found', '未找到需求。');
      item.status = 'published';
      item.published_at = fixture.clock.now;
      item.version += 1;
      return HttpResponse.json(requirementDetail(item.id));
    }),
  ),
  http.get(`${base}/tasks`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (empty(request)) return HttpResponse.json(page([]));
    const url = new URL(request.url);
    const view = url.searchParams.get('view');
    const status = url.searchParams.get('status');
    const requirementId = url.searchParams.get('requirement_id');
    const assignee = url.searchParams.get('assignee_user_id');
    const user = current(request);
    let items = [...fixture.tasks];
    if (view === 'assigned_to_me')
      items = items.filter((item) => item.assignee_user_id === user?.id);
    if (view === 'published_by_me') {
      const ownIds = new Set(
        fixture.requirements
          .filter((item) => item.publisher_user_id === user?.id)
          .map((item) => item.id),
      );
      items = items.filter((item) => ownIds.has(item.requirement_id));
    }
    if (view === 'incomplete')
      items = items.filter((item) => !['done', 'cancelled'].includes(item.status));
    if (view === 'completed') items = items.filter((item) => item.status === 'done');
    if (status) items = items.filter((item) => item.status === status);
    if (requirementId) items = items.filter((item) => item.requirement_id === requirementId);
    if (assignee) items = items.filter((item) => item.assignee_user_id === assignee);
    return HttpResponse.json(page(items));
  }),
  http.get(`${base}/tasks/:taskId`, async ({ request, params }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const detail = taskDetail(String(params.taskId));
    return detail ? HttpResponse.json(detail) : problem(404, 'not_found', '未找到任务。');
  }),
  http.post(
    `${base}/tasks/:taskId/transitions`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.tasks.find((task) => task.id === params.taskId);
      if (!item) return problem(404, 'not_found', '未找到任务。');
      const body = (await request.json()) as Schema<'TaskTransitionRequest'>;
      item.status = body.to_status;
      item.version += 1;
      item.updated_at = fixture.clock.now;
      return HttpResponse.json(taskDetail(item.id));
    }),
  ),
  http.post(
    `${base}/tasks/:taskId/submissions`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const task = fixture.tasks.find((item) => item.id === params.taskId);
      if (!task) return problem(404, 'not_found', '未找到任务。');
      if (task.assignee_user_id !== current(request)?.id)
        return problem(403, 'forbidden', '只有任务负责人可以提交结果。');
      if (task.status !== 'in_progress')
        return problem(409, 'invalid_transition', '只有进行中的任务可以提交结果。');
      const body = (await request.json()) as Schema<'CreateTaskSubmissionRequest'>;
      const submission: Schema<'TaskSubmission'> = {
        id: nextUuid(4900 + fixture.task_submissions.length),
        task_id: String(params.taskId),
        submitter_user_id: current(request)?.id ?? fixture.users[0]!.id,
        summary: body.summary,
        evidence: body.evidence,
        created_at: fixture.clock.now,
      };
      fixture.task_submissions.push(submission);
      task.status = 'review';
      task.version += 1;
      task.updated_at = fixture.clock.now;
      return HttpResponse.json(submission, { status: 201 });
    }),
  ),
  http.post(
    `${base}/tasks/:taskId/review-runs`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const body = (await request.json()) as Schema<'StartTaskReviewRequest'>;
      const task = fixture.tasks.find((item) => item.id === params.taskId);
      if (!task) return problem(404, 'not_found', '未找到任务。');
      if (me(current(request)?.username)?.department?.org_role !== 'manager')
        return problem(403, 'forbidden', '只有部门主管可以运行自动审核。');
      if (task.status !== 'review')
        return problem(409, 'invalid_task_status', '只有待审核任务可以运行自动审核。');
      if (task.version !== body.expected_version)
        return problem(412, 'version_conflict', '任务版本已更新，请刷新后重试。');
      const submission = fixture.task_submissions.find(
        (item) => item.id === body.submission_id && item.task_id === task.id,
      );
      if (!submission) return problem(409, 'submission_missing', '任务没有可审核的提交记录。');
      const operation = operationTemplate('task_review', String(params.taskId));
      return operation
        ? HttpResponse.json(
            queueOperation(request, operation, {
              taskId: String(params.taskId),
              submissionId: body.submission_id,
            }),
            { status: 202 },
          )
        : problem(404, 'not_found', '没有可用的审核结果。');
    }),
  ),
  http.post(
    `${base}/tasks/:taskId/accept`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.tasks.find((task) => task.id === params.taskId);
      if (!item) return problem(404, 'not_found', '未找到任务。');
      item.status = 'done';
      item.version += 1;
      item.updated_at = fixture.clock.now;
      return HttpResponse.json(taskDetail(item.id));
    }),
  ),
  http.post(
    `${base}/tasks/:taskId/return`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.tasks.find((task) => task.id === params.taskId);
      if (!item) return problem(404, 'not_found', '未找到任务。');
      item.status = 'in_progress';
      item.version += 1;
      item.updated_at = fixture.clock.now;
      return HttpResponse.json(taskDetail(item.id));
    }),
  ),
  http.get(`${base}/automation-operations/:operationId`, async ({ request, params }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const runtime = runtimeOperations.get(String(params.operationId));
    if (runtime) {
      runtime.polls += 1;
      runtime.operation =
        runtime.polls === 1
          ? { ...runtime.operation, status: 'running' }
          : structuredClone(runtime.finalOperation);
      if (runtime.operation.status === 'succeeded') {
        completeTaskReview(runtime);
        completeDailyReportChange(runtime);
      }
      return HttpResponse.json(runtime.operation);
    }
    const item = fixture.automation_operations.find(
      (operation) => operation.id === params.operationId,
    );
    return item ? HttpResponse.json(item) : problem(404, 'not_found', '未找到自动化操作。');
  }),
  http.get(`${base}/daily-reports`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (empty(request)) return HttpResponse.json(page([]));
    const url = new URL(request.url);
    const user = current(request);
    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const items = fixture.daily_reports.filter(
      (item) =>
        item.user_id === user?.id &&
        (!status || item.status === status) &&
        (!from || item.work_date >= from) &&
        (!to || item.work_date <= to),
    );
    return HttpResponse.json(page(items));
  }),
  http.get(`${base}/daily-reports/:workDate`, async ({ request, params }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const item = fixture.daily_reports.find(
      (report) => report.user_id === current(request)?.id && report.work_date === params.workDate,
    );
    return item
      ? HttpResponse.json(item)
      : problem(404, 'daily_report_missing', '当天还没有日报。');
  }),
  http.put(
    `${base}/daily-reports/:workDate`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const body = (await request.json()) as Schema<'UpsertDailyReportRequest'>;
      const user = current(request);
      let item = fixture.daily_reports.find(
        (report) => report.user_id === user?.id && report.work_date === params.workDate,
      );
      if (item) {
        item.content = body.content;
        item.status = 'draft';
        item.version += 1;
        item.updated_at = fixture.clock.now;
      } else {
        item = {
          id: nextUuid(7100 + fixture.daily_reports.length),
          user_id: user?.id ?? fixture.users[0]!.id,
          department_id: me(user?.username)?.department?.id ?? fixture.departments[0]!.id,
          work_date: String(params.workDate),
          content: body.content,
          status: 'draft',
          version: 1,
          published_at: null,
          updated_at: fixture.clock.now,
        };
        fixture.daily_reports.push(item);
      }
      return HttpResponse.json(item);
    }),
  ),
  http.post(
    `${base}/daily-reports/:workDate/publish`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.daily_reports.find(
        (report) => report.user_id === current(request)?.id && report.work_date === params.workDate,
      );
      if (!item) return problem(404, 'not_found', '请先保存日报。');
      item.status = 'published';
      item.version += 1;
      item.published_at = fixture.clock.now;
      return HttpResponse.json(item);
    }),
  ),
  http.post(
    `${base}/daily-reports/:workDate/rewrite-runs`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const operation = operationTemplate('daily_rewrite');
      const user = current(request);
      return operation
        ? HttpResponse.json(
            queueOperation(request, operation, undefined, {
              userId: user?.id ?? '',
              workDate: String(params.workDate),
              changeBeforeCompletion: scenario(request) === 'report-changed',
            }),
            { status: 202 },
          )
        : problem(404, 'not_found', '没有可用的改写预览。');
    }),
  ),
  http.post(
    `${base}/daily-reports/:workDate/apply-rewrite`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const body = (await request.json()) as Schema<'ApplyDailyRewriteRequest'>;
      const item = fixture.daily_reports.find(
        (report) => report.user_id === current(request)?.id && report.work_date === params.workDate,
      );
      if (!item) return problem(404, 'not_found', '请先保存日报。');
      if (item.status === 'deleted')
        return problem(409, 'daily_report_deleted', '已删除日报不能应用改写。');
      if (item.version !== body.expected_version)
        return problem(412, 'version_conflict', '日报版本已更新，请刷新后重试。');
      const operation = runtimeOperations.get(body.operation_id)?.operation;
      if (!operation || operation.kind !== 'daily_rewrite' || operation.status !== 'succeeded') {
        return problem(409, 'operation_not_ready', '日报改写操作尚未成功完成。');
      }
      item.content = body.content;
      item.status = 'draft';
      item.version += 1;
      item.updated_at = fixture.clock.now;
      return HttpResponse.json(item);
    }),
  ),
  http.delete(
    `${base}/daily-reports/:workDate`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const item = fixture.daily_reports.find(
        (report) => report.user_id === current(request)?.id && report.work_date === params.workDate,
      );
      if (!item) return problem(404, 'not_found', '未找到日报。');
      item.status = 'deleted';
      item.version += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  ),
  http.get(`${base}/departments/:departmentId/daily-reports`, async ({ request, params }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    const context = me(current(request)?.username);
    if (
      context?.department?.org_role !== 'manager' ||
      context.department.id !== params.departmentId
    ) {
      return problem(403, 'forbidden', '只有本部门主管可以查看部门日报。');
    }
    if (empty(request)) {
      return HttpResponse.json({
        department: fixture.departments[0],
        from: fixture.clock.work_date,
        to: fixture.clock.work_date,
        items: [],
        next_cursor: null,
      });
    }
    const url = new URL(request.url);
    const from =
      url.searchParams.get('date') ?? url.searchParams.get('from') ?? fixture.clock.work_date;
    const to = url.searchParams.get('date') ?? url.searchParams.get('to') ?? from;
    const memberFilter = url.searchParams.get('member_user_id');
    const members = fixture.department_members.filter(
      (item) =>
        item.department_id === params.departmentId &&
        (!memberFilter || item.user_id === memberFilter),
    );
    const items = members.map((membership) => ({
      user: fixture.users.find((user) => user.id === membership.user_id)!,
      work_date: from,
      report:
        fixture.daily_reports.find(
          (report) => report.user_id === membership.user_id && report.work_date === from,
        ) ?? null,
    }));
    return HttpResponse.json({
      department: fixture.departments.find((item) => item.id === params.departmentId)!,
      from,
      to,
      items,
      next_cursor: null,
    });
  }),
  http.get(`${base}/admin/users`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (current(request)?.platform_role !== 'admin')
      return problem(403, 'forbidden', '仅平台管理员可访问用户管理。');
    if (empty(request)) return HttpResponse.json(page([]));
    const status = new URL(request.url).searchParams.get('status');
    return HttpResponse.json(
      page(userAdminViews().filter((item) => !status || item.status === status)),
    );
  }),
  http.post(`${base}/admin/users`, async ({ request }) => {
    const blocked = await guard(request, { mutation: true });
    if (blocked) return blocked;
    const body = (await request.json()) as Schema<'CreateUserRequest'>;
    const existing = fixture.users.find((item) => item.username === body.username);
    if (existing) return problem(409, 'username_conflict', '用户名已存在。');
    const user = {
      id: nextUuid(1050 + fixture.users.length),
      username: body.username,
      display_name: body.display_name,
      platform_role: body.platform_role,
      status: 'active' as const,
    };
    fixture.users.push(user);
    return HttpResponse.json<Schema<'UserAdminView'>>(
      { ...user, department: null, version: 1 },
      { status: 201 },
    );
  }),
  http.patch(
    `${base}/admin/users/:userId`,
    mutableHandler(async ({ request, params }) => {
      const blocked = await guard(request, { mutation: true });
      if (blocked) return blocked;
      const user = fixture.users.find((item) => item.id === params.userId);
      if (!user) return problem(404, 'not_found', '未找到用户。');
      const body = (await request.json()) as Schema<'UpdateUserRequest'>;
      if (body.display_name) user.display_name = body.display_name;
      if (body.platform_role) user.platform_role = body.platform_role;
      if (body.status) user.status = body.status;
      return HttpResponse.json(userAdminViews().find((item) => item.id === user.id));
    }),
  ),
  http.get(`${base}/admin/runners`, async ({ request }) => {
    const blocked = await guard(request);
    if (blocked) return blocked;
    if (current(request)?.platform_role !== 'admin')
      return problem(403, 'forbidden', '仅平台管理员可访问 Runner 管理。');
    return HttpResponse.json(page([]));
  }),
  http.post(`${base}/admin/runners/:runnerId/stop`, async ({ request }) => {
    const blocked = await guard(request, { mutation: true });
    if (blocked) return blocked;
    return problem(404, 'not_found', 'fixture-v1 中没有 Runner 实例。');
  }),
];
