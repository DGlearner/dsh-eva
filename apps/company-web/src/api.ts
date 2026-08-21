import createClient from 'openapi-fetch';
import type { components, paths } from '@company/contracts/company-api';

export type Schema<Name extends keyof components['schemas']> = components['schemas'][Name];

export class ApiProblem extends Error {
  status: number;
  problem: Schema<'ProblemDetails'> | null;

  constructor(status: number, problem: Schema<'ProblemDetails'> | null) {
    super(problem?.detail ?? `请求失败 (${status})`);
    this.name = 'ApiProblem';
    this.status = status;
    this.problem = problem;
  }
}

const client = createClient<paths>({ baseUrl: '/company-api/v1' });
let csrfToken: string | null = null;

client.use({
  onRequest({ request }) {
    if (!import.meta.env.DEV || typeof window === 'undefined') return request;
    const search = new URLSearchParams(window.location.search);
    const mock = search.get('mock');
    const actor = search.get('as');
    if (mock) request.headers.set('X-Mock-Scenario', mock);
    if (actor) request.headers.set('X-Mock-User', actor);
    return request;
  },
});

async function unwrap<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>) {
  const { data, error, response } = await request;
  if (!response.ok || error) {
    throw new ApiProblem(response.status, (error ?? null) as Schema<'ProblemDetails'> | null);
  }
  return data as T;
}

const csrfHeaders = () => {
  if (!csrfToken) throw new Error('CSRF token is unavailable. Refresh the current session first.');
  return { 'X-CSRF-Token': csrfToken };
};
const idempotentHeaders = () => ({
  ...csrfHeaders(),
  'Idempotency-Key': crypto.randomUUID(),
});

async function rememberSession(
  request: Promise<{
    data?: Schema<'Me'>;
    error?: unknown;
    response: Response;
  }>,
) {
  const session = await unwrap<Schema<'Me'>>(request);
  csrfToken = session.csrf_token;
  return session;
}

export const api = {
  login: (body: Schema<'LoginRequest'>) => rememberSession(client.POST('/auth/login', { body })),
  logout: async () => {
    const result = await unwrap(client.POST('/auth/logout', { params: { header: csrfHeaders() } }));
    csrfToken = null;
    return result;
  },
  me: () => rememberSession(client.GET('/me')),
  modelConfig: () => unwrap(client.GET('/model-config')),
  updateModelConfig: (body: Schema<'UpdateModelConfigRequest'>) =>
    unwrap(client.PUT('/model-config', { body, params: { header: csrfHeaders() } })),
  testModelConfig: (body: Schema<'TestModelConfigRequest'>) =>
    unwrap(client.POST('/model-config/test', { body, params: { header: csrfHeaders() } })),
  knowledgeCategories: (scope: Schema<'KnowledgeScope'>) =>
    unwrap(client.GET('/knowledge/categories', { params: { query: { scope } } })),
  knowledgeDocuments: (query: {
    scope: Schema<'KnowledgeScope'>;
    category?: string;
    status?: Schema<'KnowledgeDocumentStatus'>;
  }) => unwrap(client.GET('/knowledge/documents', { params: { query } })),
  uploadKnowledge: (body: Schema<'FakeKnowledgeUploadRequest'>) =>
    unwrap(client.POST('/knowledge/uploads', { body, params: { header: idempotentHeaders() } })),
  knowledgeUpload: (uploadId: string) =>
    unwrap(
      client.GET('/knowledge/uploads/{upload_id}', { params: { path: { upload_id: uploadId } } }),
    ),
  archiveKnowledge: (documentId: string, expectedVersion: number) =>
    unwrap(
      client.POST('/knowledge/documents/{document_id}/archive', {
        params: { path: { document_id: documentId }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion, reason: null },
      }),
    ),
  restoreKnowledge: (documentId: string, expectedVersion: number) =>
    unwrap(
      client.POST('/knowledge/documents/{document_id}/restore', {
        params: { path: { document_id: documentId }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion, reason: null },
      }),
    ),
  reindexKnowledge: (documentId: string, expectedVersion: number) =>
    unwrap(
      client.POST('/knowledge/documents/{document_id}/reindex', {
        params: { path: { document_id: documentId }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion },
      }),
    ),
  requirements: (query: { view?: 'mine' | 'department'; status?: Schema<'RequirementStatus'> }) =>
    unwrap(client.GET('/requirements', { params: { query } })),
  requirement: (id: string) =>
    unwrap(
      client.GET('/requirements/{requirement_id}', { params: { path: { requirement_id: id } } }),
    ),
  createRequirement: (body: Schema<'CreateRequirementRequest'>) =>
    unwrap(client.POST('/requirements', { body, params: { header: idempotentHeaders() } })),
  updateRequirement: (id: string, body: Schema<'UpdateRequirementRequest'>) =>
    unwrap(
      client.PATCH('/requirements/{requirement_id}', {
        params: { path: { requirement_id: id }, header: csrfHeaders() },
        body,
      }),
    ),
  splitRequirement: (id: string, expectedVersion: number) =>
    unwrap(
      client.POST('/requirements/{requirement_id}/split-runs', {
        params: { path: { requirement_id: id }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion },
      }),
    ),
  applySplit: (id: string, body: Schema<'ApplySplitRequest'>) =>
    unwrap(
      client.POST('/requirements/{requirement_id}/apply-split', {
        params: { path: { requirement_id: id }, header: idempotentHeaders() },
        body,
      }),
    ),
  publishRequirement: (id: string, expectedVersion: number) =>
    unwrap(
      client.POST('/requirements/{requirement_id}/publish', {
        params: { path: { requirement_id: id }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion },
      }),
    ),
  tasks: (query: {
    view?: 'published_by_me' | 'assigned_to_me' | 'incomplete' | 'completed';
    requirement_id?: string;
    assignee_user_id?: string;
    status?: Schema<'TaskStatus'>;
  }) => unwrap(client.GET('/tasks', { params: { query } })),
  task: (id: string) =>
    unwrap(client.GET('/tasks/{task_id}', { params: { path: { task_id: id } } })),
  transitionTask: (id: string, body: Schema<'TaskTransitionRequest'>) =>
    unwrap(
      client.POST('/tasks/{task_id}/transitions', {
        params: { path: { task_id: id }, header: idempotentHeaders() },
        body,
      }),
    ),
  submitTask: (id: string, body: Schema<'CreateTaskSubmissionRequest'>) =>
    unwrap(
      client.POST('/tasks/{task_id}/submissions', {
        params: { path: { task_id: id }, header: idempotentHeaders() },
        body,
      }),
    ),
  reviewTask: (id: string, body: Schema<'StartTaskReviewRequest'>) =>
    unwrap(
      client.POST('/tasks/{task_id}/review-runs', {
        params: { path: { task_id: id }, header: idempotentHeaders() },
        body,
      }),
    ),
  acceptTask: (id: string, expectedVersion: number) =>
    unwrap(
      client.POST('/tasks/{task_id}/accept', {
        params: { path: { task_id: id }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion, reason: null },
      }),
    ),
  returnTask: (id: string, expectedVersion: number) =>
    unwrap(
      client.POST('/tasks/{task_id}/return', {
        params: { path: { task_id: id }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion, reason: '需要补充证据' },
      }),
    ),
  automationOperation: (id: string) =>
    unwrap(
      client.GET('/automation-operations/{operation_id}', {
        params: { path: { operation_id: id } },
      }),
    ),
  dailyReports: (query: { from?: string; to?: string; status?: Schema<'DailyReportStatus'> }) =>
    unwrap(client.GET('/daily-reports', { params: { query } })),
  dailyReport: (date: string) =>
    unwrap(client.GET('/daily-reports/{work_date}', { params: { path: { work_date: date } } })),
  saveDailyReport: (date: string, body: Schema<'UpsertDailyReportRequest'>) =>
    unwrap(
      client.PUT('/daily-reports/{work_date}', {
        params: { path: { work_date: date }, header: csrfHeaders() },
        body,
      }),
    ),
  publishDailyReport: (date: string, expectedVersion: number) =>
    unwrap(
      client.POST('/daily-reports/{work_date}/publish', {
        params: { path: { work_date: date }, header: idempotentHeaders() },
        body: { expected_version: expectedVersion },
      }),
    ),
  rewriteDailyReport: (date: string, body: Schema<'DailyRewriteRequest'>) =>
    unwrap(
      client.POST('/daily-reports/{work_date}/rewrite-runs', {
        params: { path: { work_date: date }, header: idempotentHeaders() },
        body,
      }),
    ),
  applyDailyRewrite: (date: string, body: Schema<'ApplyDailyRewriteRequest'>) =>
    unwrap(
      client.POST('/daily-reports/{work_date}/apply-rewrite', {
        params: { path: { work_date: date }, header: idempotentHeaders() },
        body,
      }),
    ),
  deleteDailyReport: (date: string, expectedVersion: number) =>
    unwrap(
      client.DELETE('/daily-reports/{work_date}', {
        params: {
          path: { work_date: date },
          query: { expected_version: expectedVersion },
          header: csrfHeaders(),
        },
      }),
    ),
  departmentDailyReports: (
    departmentId: string,
    query: {
      date?: string;
      from?: string;
      to?: string;
      member_user_id?: string;
      status?: Schema<'DailyReportStatus'>;
    },
  ) =>
    unwrap(
      client.GET('/departments/{department_id}/daily-reports', {
        params: { path: { department_id: departmentId }, query },
      }),
    ),
  users: (status?: Schema<'UserStatus'>) =>
    unwrap(client.GET('/admin/users', { params: { query: { status } } })),
  createUser: (body: Schema<'CreateUserRequest'>) =>
    unwrap(client.POST('/admin/users', { body, params: { header: idempotentHeaders() } })),
  updateUser: (id: string, body: Schema<'UpdateUserRequest'>) =>
    unwrap(
      client.PATCH('/admin/users/{user_id}', {
        params: { path: { user_id: id }, header: csrfHeaders() },
        body,
      }),
    ),
  runners: (state?: Schema<'RunnerState'>) =>
    unwrap(client.GET('/admin/runners', { params: { query: { state } } })),
  stopRunner: (id: string, body: Schema<'StopRunnerRequest'>) =>
    unwrap(
      client.POST('/admin/runners/{runner_id}/stop', {
        params: { path: { runner_id: id }, header: idempotentHeaders() },
        body,
      }),
    ),
};

export function problemMessage(error: unknown) {
  if (!(error instanceof ApiProblem)) return '请求暂时无法完成，请稍后重试。';
  if (error.status === 403) return '你没有权限访问此内容。';
  if (error.status === 412) return '内容已被其他操作更新，请刷新后重试。';
  return error.problem?.detail ?? error.message;
}
