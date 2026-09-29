import { createHmac, randomUUID } from 'node:crypto';

import type { KnowledgeSessionEventSink, KnowledgeToolContext } from '@company/dsh-extension';

export const SYSTEM_QUERY_TOOL_NAME = 'query_company_system';

export const SYSTEM_QUERY_RESOURCES = [
  'requirements',
  'requirement',
  'tasks',
  'task',
  'daily_reports',
  'daily_report',
  'department_daily_reports',
] as const;

export type SystemQueryResource = (typeof SYSTEM_QUERY_RESOURCES)[number];

export type SystemQueryInput = {
  resource: SystemQueryResource;
  record_id?: string;
  work_date?: string;
  date?: string;
  scope?: string;
  task_id?: string;
  view?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};

export interface SystemQueryPort {
  query(context: KnowledgeToolContext, input: SystemQueryInput): Promise<unknown>;
}

type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, execution: unknown): Promise<unknown>;
};

export interface DshSystemToolRegistry {
  register(tool: ToolDefinition): void;
}

export class CompanySystemTools {
  constructor(
    private readonly port: SystemQueryPort,
    private readonly context: KnowledgeToolContext,
    private readonly events: KnowledgeSessionEventSink,
  ) {}

  async execute(name: string, value: unknown): Promise<unknown> {
    if (name !== SYSTEM_QUERY_TOOL_NAME) throw new Error(`system tool ${name} is not registered`);
    const input = normalizeSystemQueryInput(value);
    const callId = randomUUID();
    this.events.append('company/tool-call', { call_id: callId, tool: name, input });
    const output = await this.port.query(this.context, input);
    this.events.append('company/tool-result', {
      call_id: callId,
      tool: name,
      output,
      citations: [],
    });
    return output;
  }
}

export function registerCompanySystemTools(input: {
  registry: DshSystemToolRegistry;
  defineTool: (definition: ToolDefinition) => ToolDefinition;
  context: KnowledgeToolContext;
  events: KnowledgeSessionEventSink | ((execution: unknown) => KnowledgeSessionEventSink);
  port: SystemQueryPort;
}): void {
  const toolsFor = (execution: unknown) =>
    new CompanySystemTools(
      input.port,
      input.context,
      typeof input.events === 'function' ? input.events(execution) : input.events,
    );
  input.registry.register(
    input.defineTool({
      name: SYSTEM_QUERY_TOOL_NAME,
      description:
        'Query Company Workbench records visible to the current user. Supports requirement/task lists and details, personal, department, company, and task daily reports, plus manager-only department overviews. Use list resources before requesting a detail. Identity and department are always supplied by the trusted runner.',
      parameters: {
        resource: { type: 'string', enum: SYSTEM_QUERY_RESOURCES, required: true },
        record_id: {
          type: 'string',
          description: 'Requirement or task UUID for a detail resource.',
        },
        work_date: {
          type: 'string',
          description: 'YYYY-MM-DD for daily_report.',
        },
        date: {
          type: 'string',
          description: 'YYYY-MM-DD exact date for department_daily_reports.',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'department', 'company', 'task'],
          description: 'Daily report scope. daily_report defaults to department.',
        },
        task_id: {
          type: 'string',
          description: 'Task UUID, required only when scope is task.',
        },
        view: {
          type: 'string',
          enum: [
            'mine',
            'department',
            'published_by_me',
            'assigned_to_me',
            'incomplete',
            'completed',
          ],
          description:
            'Optional list view. Use mine/department for requirements, published_by_me/assigned_to_me/incomplete/completed for tasks, and mine for daily_reports.',
        },
        status: { type: 'string' },
        from: { type: 'string', description: 'Inclusive YYYY-MM-DD start date.' },
        to: { type: 'string', description: 'Inclusive YYYY-MM-DD end date.' },
        cursor: { type: 'string' },
        limit: { type: 'integer', description: 'Page size from 1 through 100.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) ?? 'null' },
        ],
      },
      execute: (args, execution) => toolsFor(execution).execute(SYSTEM_QUERY_TOOL_NAME, args),
    }),
  );
}

export class ControlPlaneSystemQueryClient implements SystemQueryPort {
  private readonly endpoint: URL;
  private readonly secret: Buffer;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly options: {
      endpoint: string;
      tenantId: string;
      userId: string;
      runnerId: string;
      identitySecretBase64: string;
      fetch?: typeof fetch;
    },
  ) {
    this.endpoint = parseEndpoint(options.endpoint);
    this.secret = Buffer.from(options.identitySecretBase64, 'base64');
    if (this.secret.byteLength < 32) {
      throw new Error('Runner identity secret must contain at least 32 bytes');
    }
    for (const [name, value] of Object.entries({
      tenantId: options.tenantId,
      userId: options.userId,
      runnerId: options.runnerId,
    })) {
      if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
    }
    this.fetcher = options.fetch ?? fetch;
  }

  async query(context: KnowledgeToolContext, rawInput: SystemQueryInput): Promise<unknown> {
    if (context.tenantId !== this.options.tenantId || context.userId !== this.options.userId) {
      throw new Error('System query context does not match the runner identity');
    }
    const input = normalizeSystemQueryInput(rawInput);
    const requestId = randomUUID();
    const token = signRunnerToolToken(
      {
        tenantId: this.options.tenantId,
        userId: this.options.userId,
        runnerId: this.options.runnerId,
        requestId,
      },
      this.secret,
    );
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify(input),
      });
    } catch {
      throw new Error('Company system query is temporarily unavailable');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('Company system query response is too large');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('Company system query response is too large');
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('Company system query returned an invalid response');
    }
    if (!response.ok) {
      const code =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).code
          : undefined;
      throw new Error(
        `Company system query failed (${response.status}${typeof code === 'string' ? ` ${code}` : ''})`,
      );
    }
    return value;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOOL_ENDPOINT_PATH = '/internal/v1/agent-tools/query-company-system';
const FORBIDDEN_ARGUMENTS = new Set([
  'user_id',
  'tenant_id',
  'department_id',
  'member_user_id',
  'url',
  'endpoint',
  'header',
  'headers',
  'token',
]);
const COMMON_KEYS = new Set([
  'resource',
  'record_id',
  'work_date',
  'date',
  'scope',
  'task_id',
  'view',
  'status',
  'from',
  'to',
  'cursor',
  'limit',
]);
const RESOURCE_KEYS: Record<SystemQueryResource, ReadonlySet<string>> = {
  requirements: new Set(['resource', 'view', 'status', 'cursor', 'limit']),
  requirement: new Set(['resource', 'record_id']),
  tasks: new Set(['resource', 'view', 'status', 'from', 'to', 'cursor', 'limit']),
  task: new Set(['resource', 'record_id']),
  daily_reports: new Set([
    'resource',
    'view',
    'status',
    'scope',
    'task_id',
    'from',
    'to',
    'cursor',
    'limit',
  ]),
  daily_report: new Set(['resource', 'work_date', 'scope', 'task_id']),
  department_daily_reports: new Set([
    'resource',
    'date',
    'status',
    'from',
    'to',
    'cursor',
    'limit',
  ]),
};
const REQUIREMENT_STATUS = new Set(['draft', 'published', 'cancelled']);
const TASK_STATUS = new Set([
  'planning',
  'todo',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
]);
const REPORT_STATUS = new Set(['draft', 'published', 'deleted']);
const REPORT_SCOPE = new Set(['personal', 'department', 'company', 'task']);

export function normalizeSystemQueryInput(value: unknown): SystemQueryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('system query input must be an object');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_ARGUMENTS.has(key) || !COMMON_KEYS.has(key)) {
      throw new Error(`system query argument ${key} is not allowed`);
    }
  }
  if (
    typeof input.resource !== 'string' ||
    !(SYSTEM_QUERY_RESOURCES as readonly string[]).includes(input.resource)
  ) {
    throw new Error('system query resource is invalid');
  }
  const resource = input.resource as SystemQueryResource;
  for (const key of Object.keys(input)) {
    if (!RESOURCE_KEYS[resource].has(key)) {
      throw new Error(`system query argument ${key} is not allowed for ${resource}`);
    }
  }
  const output: SystemQueryInput = { resource };
  if (input.record_id !== undefined) output.record_id = uuid(input.record_id, 'record_id');
  if (input.work_date !== undefined) output.work_date = date(input.work_date, 'work_date');
  if (input.date !== undefined) output.date = date(input.date, 'date');
  if (input.scope !== undefined) output.scope = string(input.scope, 'scope', 32);
  if (input.task_id !== undefined) output.task_id = uuid(input.task_id, 'task_id');
  if (input.from !== undefined) output.from = date(input.from, 'from');
  if (input.to !== undefined) output.to = date(input.to, 'to');
  if (input.cursor !== undefined) output.cursor = string(input.cursor, 'cursor', 2048);
  if (input.limit !== undefined) output.limit = integer(input.limit, 'limit', 1, 100);
  if (input.view !== undefined) output.view = string(input.view, 'view', 64);
  if (input.status !== undefined) output.status = string(input.status, 'status', 64);
  validateResourceQuery(output);
  return output;
}

function validateResourceQuery(input: SystemQueryInput): void {
  if ((input.resource === 'requirement' || input.resource === 'task') && !input.record_id) {
    throw new Error(`record_id is required for ${input.resource}`);
  }
  if (input.resource === 'daily_report' && !input.work_date) {
    throw new Error('work_date is required for daily_report');
  }
  if (input.resource === 'daily_report' && !input.scope) input.scope = 'department';
  if (
    (input.resource === 'daily_report' || input.resource === 'daily_reports') &&
    input.scope &&
    !REPORT_SCOPE.has(input.scope)
  ) {
    throw new Error(`scope is invalid for ${input.resource}`);
  }
  if (
    (input.resource === 'daily_report' || input.resource === 'daily_reports') &&
    (input.scope === 'task') !== (input.task_id !== undefined)
  ) {
    throw new Error('task_id is required only for task reports');
  }
  if (input.resource === 'daily_reports' && input.view && input.view !== 'mine') {
    throw new Error('view is invalid for daily_reports');
  }
  if (
    input.resource === 'requirements' &&
    input.view &&
    !['mine', 'department'].includes(input.view)
  ) {
    throw new Error('view is invalid for requirements');
  }
  if (
    input.resource === 'tasks' &&
    input.view &&
    !['published_by_me', 'assigned_to_me', 'incomplete', 'completed'].includes(input.view)
  ) {
    throw new Error('view is invalid for tasks');
  }
  const statuses =
    input.resource === 'requirements'
      ? REQUIREMENT_STATUS
      : input.resource === 'tasks'
        ? TASK_STATUS
        : input.resource === 'daily_reports' || input.resource === 'department_daily_reports'
          ? REPORT_STATUS
          : null;
  if (input.status && !statuses?.has(input.status)) {
    throw new Error(`status is invalid for ${input.resource}`);
  }
  if (input.resource === 'department_daily_reports' && input.date && (input.from || input.to)) {
    throw new Error('date cannot be combined with from or to');
  }
  if (input.from && input.to && input.from > input.to) throw new Error('from must not exceed to');

  // Personal reports are already scoped by the authenticated Runner identity.
  // Accept the model's explicit "mine" intent without forwarding a redundant query parameter.
  if (input.resource === 'daily_reports' && input.view === 'mine') delete input.view;
}

function parseEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== TOOL_ENDPOINT_PATH ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(`Agent Tool Gateway endpoint must be an HTTP(S) URL at ${TOOL_ENDPOINT_PATH}`);
  }
  return endpoint;
}

function signRunnerToolToken(
  input: { tenantId: string; userId: string; runnerId: string; requestId: string },
  secret: Uint8Array,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: 'company-dsh-runner',
    aud: 'company-agent-tool-gateway',
    iat: now,
    exp: now + 60,
    tenant_id: input.tenantId,
    user_id: input.userId,
    runner_id: input.runnerId,
    request_id: input.requestId,
  });
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`, 'ascii')
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

function date(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  return value;
}

function string(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer in range ${minimum}-${maximum}`);
  }
  return value as number;
}
