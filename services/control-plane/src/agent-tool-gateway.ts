import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decodeJwt, jwtVerify } from 'jose';

import {
  deriveRunnerIdentitySecret,
  normalizeSystemQueryInput,
  type SystemQueryInput,
} from '@company/dsh-runner';

import type { PlatformRepository } from './domain.js';
import {
  type FetchLike,
  parseBusinessApiUrl,
  sendUpstreamResponse,
  signBusinessActorToken,
} from './business-gateway.js';
import { HttpProblem } from './problems.js';

const RUNNER_TOKEN_ISSUER = 'company-dsh-runner';
const RUNNER_TOKEN_AUDIENCE = 'company-agent-tool-gateway';
const TOOL_ROUTE = '/internal/v1/agent-tools/query-company-system';
const MAX_TOOL_REQUEST_BYTES = 64 * 1024;
const READY_RUNNER_STATES = new Set(['ready', 'busy', 'idle']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AgentToolRunnerRegistry {
  list(tenantId?: string): Promise<unknown[]>;
}

export type AgentToolGatewayOptions = {
  repository: PlatformRepository;
  runnerRegistry: AgentToolRunnerRegistry;
  runnerIdentityRootSecret: Uint8Array;
  businessApiUrl: string;
  actorTokenSecret: string;
  actorTokenIssuer?: string;
  fetch?: FetchLike;
  now?: () => Date;
};

type RunnerClaims = {
  tenantId: string;
  userId: string;
  runnerId: string;
  requestId: string;
};

export function registerAgentToolGateway(
  app: FastifyInstance,
  options: AgentToolGatewayOptions,
): void {
  if (options.runnerIdentityRootSecret.byteLength < 32) {
    throw new Error('Runner identity root secret must contain at least 32 bytes');
  }
  if (options.actorTokenSecret.length < 32) {
    throw new Error('ACTOR_TOKEN_SECRET must contain at least 32 characters');
  }
  const businessApi = parseBusinessApiUrl(options.businessApiUrl);
  const actorTokenKey = new TextEncoder().encode(options.actorTokenSecret);
  const actorTokenIssuer = options.actorTokenIssuer ?? 'company-control-plane';
  if (!actorTokenIssuer.trim()) throw new Error('ACTOR_TOKEN_ISSUER must not be empty');
  const fetchUpstream = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  app.post(TOOL_ROUTE, { bodyLimit: MAX_TOOL_REQUEST_BYTES }, async (request, reply) => {
    const claims = await authenticateRunner(request, options, now());
    return queryBusinessApi(request, reply, claims, {
      ...options,
      businessApi,
      actorTokenKey,
      actorTokenIssuer,
      fetchUpstream,
      now: now(),
    });
  });
}

async function authenticateRunner(
  request: FastifyRequest,
  options: AgentToolGatewayOptions,
  currentDate: Date,
): Promise<RunnerClaims> {
  const authorization = singleHeader(request.headers.authorization);
  if (!authorization?.startsWith('Bearer ')) throw invalidRunnerIdentity();
  const token = authorization.slice('Bearer '.length);
  let unverified: ReturnType<typeof decodeJwt>;
  try {
    unverified = decodeJwt(token);
  } catch {
    throw invalidRunnerIdentity();
  }
  const tenantId = claimUuid(unverified.tenant_id);
  const userId = claimUuid(unverified.user_id);
  const runnerId = claimUuid(unverified.runner_id);
  const requestId = claimUuid(unverified.request_id);
  const headerRequestId = singleHeader(request.headers['x-request-id']);
  if (!tenantId || !userId || !runnerId || !requestId || headerRequestId !== requestId) {
    throw invalidRunnerIdentity();
  }
  const secret = deriveRunnerIdentitySecret(options.runnerIdentityRootSecret, {
    tenantId,
    userId,
    runnerId,
  });
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  let protectedHeader: Awaited<ReturnType<typeof jwtVerify>>['protectedHeader'];
  try {
    const verified = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer: RUNNER_TOKEN_ISSUER,
      audience: RUNNER_TOKEN_AUDIENCE,
      currentDate,
      maxTokenAge: '60 seconds',
    });
    payload = verified.payload;
    protectedHeader = verified.protectedHeader;
  } catch {
    throw invalidRunnerIdentity();
  }
  if (
    protectedHeader.typ !== 'JWT' ||
    payload.tenant_id !== tenantId ||
    payload.user_id !== userId ||
    payload.runner_id !== runnerId ||
    payload.request_id !== requestId ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 60
  ) {
    throw invalidRunnerIdentity();
  }

  let runners: unknown[];
  try {
    runners = await options.runnerRegistry.list(tenantId);
  } catch {
    throw new HttpProblem(503, 'runner_manager_unavailable', 'Runner Manager is unavailable');
  }
  const active = runners.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const runner = value as Record<string, unknown>;
    return (
      runner.id === runnerId &&
      runner.tenant_id === tenantId &&
      runner.user_id === userId &&
      READY_RUNNER_STATES.has(String(runner.state))
    );
  });
  if (!active) throw invalidRunnerIdentity();
  return { tenantId, userId, runnerId, requestId };
}

async function queryBusinessApi(
  request: FastifyRequest,
  reply: FastifyReply,
  claims: RunnerClaims,
  options: {
    repository: PlatformRepository;
    businessApi: URL;
    actorTokenKey: Uint8Array;
    actorTokenIssuer: string;
    fetchUpstream: FetchLike;
    now: Date;
  },
): Promise<FastifyReply> {
  const user = await options.repository.getUser(claims.userId);
  if (!user || user.status !== 'active' || user.tenantId !== claims.tenantId) {
    throw new HttpProblem(401, 'account_unavailable', 'Account is not active');
  }
  const membership = await options.repository.getMembership(user.id);
  const department = membership
    ? await options.repository.getDepartment(membership.departmentId)
    : null;
  if (
    membership &&
    (!department || department.tenantId !== user.tenantId || department.status !== 'active')
  ) {
    throw new HttpProblem(403, 'membership_unavailable', 'Department membership is unavailable');
  }

  let input: SystemQueryInput;
  try {
    input = normalizeSystemQueryInput(request.body);
  } catch {
    throw new HttpProblem(400, 'agent_tool_input_invalid', 'Agent Tool input is invalid');
  }
  if (input.resource === 'department_daily_reports' && membership?.orgRole !== 'manager') {
    throw new HttpProblem(
      403,
      'department_manager_required',
      'Department manager role is required',
    );
  }
  const path = businessPath(input, membership?.departmentId ?? null);
  const actorToken = await signBusinessActorToken(
    {
      tenantId: user.tenantId,
      userId: user.id,
      sessionId: claims.runnerId,
      platformRole: user.platformRole,
      departmentId: membership?.departmentId ?? null,
      orgRole: membership?.orgRole ?? null,
    },
    claims.requestId,
    options.actorTokenKey,
    options.actorTokenIssuer,
    options.now,
  );
  let response: Response;
  try {
    response = await options.fetchUpstream(new URL(path, options.businessApi.origin), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${actorToken}`,
        'x-request-id': claims.requestId,
      },
    });
  } catch {
    throw new HttpProblem(
      502,
      'business_api_unavailable',
      'Business API is temporarily unavailable',
    );
  }
  return sendUpstreamResponse(response, reply);
}

export function businessPath(input: SystemQueryInput, departmentId: string | null): string {
  const query = new URLSearchParams();
  for (const key of [
    'view',
    'status',
    'from',
    'to',
    'date',
    'scope',
    'task_id',
    'cursor',
    'limit',
  ] as const) {
    const value = input[key];
    if (value !== undefined) query.set(key, String(value));
  }
  let pathname: string;
  switch (input.resource) {
    case 'requirements':
      pathname = '/company-api/v1/requirements';
      break;
    case 'requirement':
      pathname = `/company-api/v1/requirements/${encodeURIComponent(input.record_id!)}`;
      break;
    case 'tasks':
      pathname = '/company-api/v1/tasks';
      break;
    case 'task':
      pathname = `/company-api/v1/tasks/${encodeURIComponent(input.record_id!)}`;
      break;
    case 'daily_reports':
      pathname = '/company-api/v1/daily-reports';
      break;
    case 'daily_report':
      pathname = `/company-api/v1/daily-reports/${encodeURIComponent(input.work_date!)}`;
      break;
    case 'department_daily_reports':
      if (!departmentId) {
        throw new HttpProblem(403, 'department_required', 'Department membership is required');
      }
      pathname = `/company-api/v1/departments/${encodeURIComponent(departmentId)}/daily-reports`;
      break;
  }
  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function claimUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function invalidRunnerIdentity(): HttpProblem {
  return new HttpProblem(401, 'runner_identity_invalid', 'Runner identity is invalid');
}
