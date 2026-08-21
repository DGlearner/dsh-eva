import { createHash, randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { redactSensitiveFields } from '@company/observability';

import {
  type AutomationExecutor,
  type AutomationPurpose,
  StubAutomationExecutor,
} from './automation.js';
import type {
  AuditEventRecord,
  AuthContext,
  DepartmentRecord,
  MembershipRecord,
  ModelConfigRecord,
  PlatformRepository,
  SessionRecord,
  UserRecord,
  UserStatus,
} from './domain.js';
import { HttpProblem, sendProblem } from './problems.js';
import {
  FixedWindowLoginLimiter,
  SecretCipher,
  SESSION_COOKIE,
  authenticate,
  createSessionRecord,
  parseCookies,
  validateExternalBaseUrl,
} from './security.js';

const CSRF_COOKIE = 'company_csrf';

export type ModelProbeInput = {
  baseUrl: string;
  model: string;
  apiKey: string | null;
};

export type UserConfigMaterializationStage = {
  stageId: string;
  userId: string;
  configVersion: number;
  handle?: unknown;
};

export interface UserConfigMaterializer {
  stage(input: {
    stageId: string;
    tenantId: string;
    userId: string;
    username: string;
    displayName: string;
    config: ModelConfigRecord;
    apiKey: string | null;
  }): Promise<UserConfigMaterializationStage>;
  activate(stage: UserConfigMaterializationStage): Promise<void>;
  rollback(stage: UserConfigMaterializationStage): Promise<void>;
}

export interface RunnerAdminClient {
  list(tenantId?: string): Promise<unknown[]>;
  stop(runnerId: string, reason: string, gracePeriodSeconds: number): Promise<unknown>;
  stopForUser?(userId: string, reason: string): Promise<void>;
}

export type ControlPlaneOptions = {
  repository: PlatformRepository;
  secretCipher: SecretCipher;
  secureCookies?: boolean;
  serviceToken?: string;
  automationExecutor?: AutomationExecutor;
  loginLimiter?: FixedWindowLoginLimiter;
  validateModelUrl?: (value: string) => Promise<URL>;
  modelProbe?: (
    input: ModelProbeInput,
  ) => Promise<{ ok: boolean; latencyMs: number; errorCode: string | null }>;
  configMaterializer?: UserConfigMaterializer;
  runnerAdminClient?: RunnerAdminClient;
};

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpProblem(400, 'invalid_request', 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
  minimum = 1,
  maximum = 20_000,
): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum) {
    throw new HttpProblem(400, 'invalid_request', `${key} is invalid`, [
      {
        field: key,
        code: 'invalid',
        message: `${key} must contain ${minimum}-${maximum} characters`,
      },
    ]);
  }
  return value.trim();
}

function requiredSecretString(
  body: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new HttpProblem(400, 'invalid_request', `${key} is invalid`, [
      {
        field: key,
        code: 'invalid',
        message: `${key} must contain ${minimum}-${maximum} characters`,
      },
    ]);
  }
  return value;
}

function requiredInteger(body: Record<string, unknown>, key: string, minimum = 0): number {
  const value = body[key];
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new HttpProblem(400, 'invalid_request', `${key} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function optionalInteger(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new HttpProblem(400, 'invalid_request', `${key} must be null or a positive integer`);
  }
  return value as number;
}

function assertAdmin(context: AuthContext): void {
  if (context.user.platformRole !== 'admin') {
    throw new HttpProblem(403, 'admin_required', 'Platform administrator role is required');
  }
}

function userSummary(user: UserRecord) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    platform_role: user.platformRole,
  };
}

function departmentView(department: DepartmentRecord) {
  return {
    id: department.id,
    name: department.name,
    status: department.status,
    version: department.version,
  };
}

function membershipView(membership: MembershipRecord) {
  return {
    department_id: membership.departmentId,
    user_id: membership.userId,
    org_role: membership.orgRole,
    version: membership.version,
  };
}

async function meView(repository: PlatformRepository, context: AuthContext) {
  return {
    user: userSummary(context.user),
    department:
      context.membership && context.department
        ? {
            id: context.department.id,
            name: context.department.name,
            org_role: context.membership.orgRole,
          }
        : null,
    csrf_token: context.csrfToken,
  };
}

function modelView(config: ModelConfigRecord) {
  return {
    base_url: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    max_output_tokens: config.maxOutputTokens,
    has_api_key: config.apiKeyCiphertext !== null,
    api_key_hint: config.apiKeyHint,
    version: config.version,
    updated_at: config.updatedAt.toISOString(),
  };
}

function sessionView(session: SessionRecord) {
  return {
    id: session.sessionId,
    workspace_id: session.workspaceId,
    title: session.title,
    status: session.status,
    last_event_position: session.lastEventPosition,
    last_event_at: session.lastEventAt?.toISOString() ?? null,
    version: session.version,
  };
}

function apiKeyHint(apiKey: string): string {
  return apiKey.length <= 4 ? '****' : `****${apiKey.slice(-4)}`;
}

async function defaultModelProbe(
  input: ModelProbeInput,
  validateUrl: (value: string) => Promise<URL>,
) {
  const startedAt = performance.now();
  try {
    let url = await validateUrl(input.baseUrl);
    url = new URL('models', url.href.endsWith('/') ? url.href : `${url.href}/`);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {},
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('redirect_not_allowed');
        url = await validateUrl(new URL(location, url).href);
        continue;
      }
      return {
        ok: response.ok,
        latencyMs: Math.round(performance.now() - startedAt),
        errorCode: response.ok ? null : `upstream_${response.status}`,
      };
    }
  } catch {
    // Connection details are intentionally collapsed so secrets and internal addresses stay out of responses.
  }
  return {
    ok: false,
    latencyMs: Math.round(performance.now() - startedAt),
    errorCode: 'model_unreachable',
  };
}

export function buildControlPlane(options: ControlPlaneOptions): FastifyInstance {
  const repository = options.repository;
  const limiter = options.loginLimiter ?? new FixedWindowLoginLimiter();
  const automation = options.automationExecutor ?? new StubAutomationExecutor();
  const validateModelUrl = options.validateModelUrl ?? validateExternalBaseUrl;
  const modelProbe =
    options.modelProbe ?? ((input: ModelProbeInput) => defaultModelProbe(input, validateModelUrl));
  const materializer =
    options.configMaterializer ??
    ({
      stage: async ({ stageId, userId, config }) => ({
        stageId,
        userId,
        configVersion: config.configVersion,
      }),
      activate: async () => undefined,
      rollback: async () => undefined,
    } satisfies UserConfigMaterializer);
  const app = Fastify({
    logger: false,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length >= 8 && incoming.length <= 128
        ? incoming
        : randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  app.setErrorHandler((error, request, reply) => {
    let problem: HttpProblem;
    if (error instanceof HttpProblem) problem = error;
    else if ((error as { statusCode?: unknown }).statusCode === 413)
      problem = new HttpProblem(413, 'request_body_too_large', 'Request body is too large');
    else if ((error as { statusCode?: unknown }).statusCode === 415)
      problem = new HttpProblem(415, 'content_type_unsupported', 'Content type is not supported');
    else problem = new HttpProblem(500, 'internal_error', 'The request could not be completed');
    void sendProblem(request, reply, problem);
  });

  const audit = async (
    request: FastifyRequest,
    input: Omit<AuditEventRecord, 'id' | 'requestId' | 'createdAt' | 'details'> & {
      details?: Record<string, unknown>;
    },
  ) => {
    await repository.appendAudit({
      ...input,
      id: randomUUID(),
      requestId: request.id,
      details: (redactSensitiveFields(input.details ?? {}) ?? {}) as Record<string, unknown>,
      createdAt: new Date(),
    });
  };

  const auth = (request: FastifyRequest, requireCsrf = false) =>
    authenticate(request, repository, { requireCsrf });

  const getIdempotency = async (
    request: FastifyRequest,
    context: AuthContext,
    route: string,
    body: unknown,
  ) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new HttpProblem(400, 'idempotency_key_required', 'A valid Idempotency-Key is required');
    }
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const existing = await repository.getIdempotency(
      context.user.tenantId,
      context.user.id,
      route,
      key,
    );
    if (existing && existing.requestHash !== requestHash) {
      throw new HttpProblem(
        409,
        'idempotency_key_reused',
        'Idempotency-Key was reused with another request',
      );
    }
    return { key, requestHash, existing };
  };

  app.post('/company-api/v1/auth/login', async (request, reply) => {
    const body = objectBody(request.body);
    const username = requiredString(body, 'username', 1, 100);
    const password = requiredSecretString(body, 'password', 8, 128);
    const limiterKey = `${request.ip}:${username.toLocaleLowerCase('en-US')}`;
    limiter.assertAllowed(limiterKey);
    const tenantId = await repository.getDefaultTenantId();
    const user = await repository.findUserByUsername(username);
    const valid = user?.status === 'active' && (await argon2.verify(user.passwordHash, password));
    if (!valid || !user) {
      await audit(request, {
        tenantId,
        actorUserId: user?.id ?? null,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user?.id ?? null,
        result: 'failure',
        details: { username },
      });
      throw new HttpProblem(401, 'invalid_credentials', 'Username or password is invalid');
    }

    limiter.reset(limiterKey);
    const created = createSessionRecord(user.id);
    await repository.createWebSession(created.record);
    await audit(request, {
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: 'auth.login',
      resourceType: 'web_session',
      resourceId: created.record.id,
      result: 'success',
    });

    const secure = options.secureCookies ? '; Secure' : '';
    reply.header('set-cookie', [
      `${SESSION_COOKIE}=${encodeURIComponent(created.token)}; HttpOnly; SameSite=Lax; Path=/${secure}`,
      `${CSRF_COOKIE}=${encodeURIComponent(created.csrfToken)}; SameSite=Lax; Path=/${secure}`,
    ]);
    const membership = await repository.getMembership(user.id);
    const department = membership ? await repository.getDepartment(membership.departmentId) : null;
    return meView(repository, {
      session: created.record,
      user,
      membership,
      department,
      csrfToken: created.csrfToken,
    });
  });

  app.post('/company-api/v1/auth/logout', async (request, reply) => {
    const context = await auth(request, true);
    await repository.revokeWebSession(context.session.id);
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'auth.logout',
      resourceType: 'web_session',
      resourceId: context.session.id,
      result: 'success',
    });
    reply.header('set-cookie', [
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
    ]);
    return reply.code(204).send();
  });

  app.post('/company-api/v1/auth/change-password', async (request, reply) => {
    const context = await auth(request, true);
    const body = objectBody(request.body);
    const currentPassword = requiredSecretString(body, 'current_password', 8, 128);
    const newPassword = requiredSecretString(body, 'new_password', 8, 128);
    if (!(await argon2.verify(context.user.passwordHash, currentPassword))) {
      throw new HttpProblem(401, 'invalid_credentials', 'Current password is invalid');
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await repository.replacePassword(context.user.id, passwordHash, false);
    await repository.revokeUserSessions(context.user.id);
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'auth.password_changed',
      resourceType: 'user',
      resourceId: context.user.id,
      result: 'success',
    });
    reply.header('set-cookie', [
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
    ]);
    return reply.code(204).send();
  });

  app.get('/company-api/v1/me', async (request) => {
    const context = await auth(request);
    const cookieCsrf = parseCookies(request.headers.cookie)[CSRF_COOKIE];
    if (
      !cookieCsrf ||
      context.session.csrfHash !== createHash('sha256').update(cookieCsrf).digest('hex')
    ) {
      throw new HttpProblem(401, 'session_csrf_missing', 'Session CSRF token is unavailable');
    }
    return meView(repository, { ...context, csrfToken: cookieCsrf });
  });

  app.get('/company-api/v1/model-config', async (request) => {
    const context = await auth(request);
    const config = await repository.getModelConfig(context.user.id);
    if (!config)
      throw new HttpProblem(404, 'model_config_not_found', 'Model configuration is not set');
    return modelView(config);
  });

  app.put('/company-api/v1/model-config', async (request) => {
    const context = await auth(request, true);
    const body = objectBody(request.body);
    const baseUrl = requiredString(body, 'base_url', 1, 2048);
    await validateModelUrl(baseUrl);
    const model = requiredString(body, 'model', 1, 200);
    const expectedVersion = requiredInteger(body, 'expected_version');
    const temperature = body.temperature === undefined ? 0.7 : Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new HttpProblem(400, 'invalid_temperature', 'temperature must be between 0 and 2');
    }
    const maxOutputTokens = optionalInteger(body, 'max_output_tokens') ?? null;
    const apiKey = body.api_key;
    if (
      apiKey !== undefined &&
      (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096)
    ) {
      throw new HttpProblem(400, 'invalid_api_key', 'api_key must contain 1-4096 characters');
    }
    const config = await repository.withUserConfigLock(context.user.id, async () => {
      const existing = await repository.getModelConfig(context.user.id);
      const now = new Date();
      const staged = await repository.stageModelConfig(
        {
          id: existing?.id ?? randomUUID(),
          userId: context.user.id,
          baseUrl,
          model,
          temperature,
          maxOutputTokens,
          apiKeyCiphertext:
            typeof apiKey === 'string'
              ? options.secretCipher.seal(apiKey)
              : (existing?.apiKeyCiphertext ?? null),
          apiKeyHint:
            typeof apiKey === 'string' ? apiKeyHint(apiKey) : (existing?.apiKeyHint ?? null),
          configVersion: existing?.configVersion ?? 0,
          version: existing?.version ?? 0,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
        expectedVersion,
      );
      let materialized: UserConfigMaterializationStage | undefined;
      let markerActivated = false;
      try {
        const resolvedKey = staged.apiKeyCiphertext
          ? options.secretCipher.open(staged.apiKeyCiphertext)
          : null;
        materialized = await materializer.stage({
          stageId: staged.stageId,
          tenantId: context.user.tenantId,
          userId: context.user.id,
          username: context.user.username,
          displayName: context.user.displayName,
          config: staged,
          apiKey: resolvedKey,
        });
        await options.runnerAdminClient?.stopForUser?.(
          context.user.id,
          'model_configuration_changed',
        );
        await materializer.activate(materialized);
        markerActivated = true;
        return await repository.activateModelConfig(staged.stageId);
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        if (markerActivated && materialized) {
          try {
            await materializer.rollback(materialized);
          } catch (rollbackError) {
            recoveryErrors.push(rollbackError);
          }
        }
        try {
          await repository.failModelConfigStage(staged.stageId, modelConfigFailureCode(error));
        } catch (stageError) {
          recoveryErrors.push(stageError);
        }
        if (recoveryErrors.length > 0) {
          throw new AggregateError(
            [error, ...recoveryErrors],
            'Model configuration failed and recovery was incomplete',
          );
        }
        throw error;
      }
    });
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'model_config.updated',
      resourceType: 'model_config',
      resourceId: config.id,
      result: 'success',
      details: { base_url: baseUrl, model, api_key_changed: typeof apiKey === 'string' },
    });
    return modelView(config);
  });

  app.post('/company-api/v1/model-config/test', async (request) => {
    const context = await auth(request, true);
    const body = objectBody(request.body);
    const baseUrl = requiredString(body, 'base_url', 1, 2048);
    await validateModelUrl(baseUrl);
    const model = requiredString(body, 'model', 1, 200);
    const suppliedKey = body.api_key;
    if (suppliedKey !== undefined && suppliedKey !== null && typeof suppliedKey !== 'string') {
      throw new HttpProblem(400, 'invalid_api_key', 'api_key must be a string or null');
    }
    const existing = await repository.getModelConfig(context.user.id);
    const apiKey =
      typeof suppliedKey === 'string'
        ? suppliedKey
        : existing?.apiKeyCiphertext
          ? options.secretCipher.open(existing.apiKeyCiphertext)
          : null;
    const result = await modelProbe({ baseUrl, model, apiKey });
    return { ok: result.ok, latency_ms: result.latencyMs, error_code: result.errorCode };
  });

  app.get('/company-api/v1/sessions', async (request) => {
    const context = await auth(request);
    const query = request.query as { status?: string };
    const allowed = ['active', 'archived', 'interrupted', 'corrupted'];
    if (query.status && !allowed.includes(query.status)) {
      throw new HttpProblem(400, 'invalid_session_status', 'Session status is invalid');
    }
    const sessions = await repository.listSessions(
      context.user.id,
      query.status as SessionRecord['status'] | undefined,
    );
    return { items: sessions.map(sessionView), next_cursor: null };
  });

  app.get('/company-api/v1/sessions/:session_id', async (request) => {
    const context = await auth(request);
    const { session_id: sessionId } = request.params as { session_id: string };
    const session = await repository.getSession(context.user.id, sessionId);
    if (!session) throw new HttpProblem(404, 'session_not_found', 'Session was not found');
    return sessionView(session);
  });

  app.post('/company-api/v1/sessions/:session_id/archive', async (request) => {
    const context = await auth(request, true);
    const { session_id: sessionId } = request.params as { session_id: string };
    const body = objectBody(request.body);
    const session = await repository.archiveSession(
      context.user.id,
      sessionId,
      requiredInteger(body, 'expected_version', 1),
    );
    return sessionView(session);
  });

  app.get('/company-api/v1/admin/users', async (request) => {
    const context = await auth(request);
    assertAdmin(context);
    const query = request.query as { status?: UserStatus };
    const users = await repository.listUsers(context.user.tenantId, query.status);
    const items = await Promise.all(
      users.map(async (user) => ({
        ...userSummary(user),
        status: user.status,
        department: await repository
          .getMembership(user.id)
          .then((value) => (value ? membershipView(value) : null)),
        version: user.version,
      })),
    );
    return { items, next_cursor: null };
  });

  app.post('/company-api/v1/admin/users', async (request, reply) => {
    const context = await auth(request, true);
    assertAdmin(context);
    const body = objectBody(request.body);
    const idempotency = await getIdempotency(request, context, 'POST:/admin/users', body);
    if (idempotency.existing)
      return reply.code(idempotency.existing.statusCode).send(idempotency.existing.response);
    const now = new Date();
    const temporaryPassword = requiredSecretString(body, 'temporary_password', 8, 128);
    const platformRole = requiredString(body, 'platform_role') as UserRecord['platformRole'];
    if (!['admin', 'member'].includes(platformRole)) {
      throw new HttpProblem(400, 'invalid_platform_role', 'platform_role is invalid');
    }
    const user: UserRecord = {
      id: randomUUID(),
      tenantId: context.user.tenantId,
      username: requiredString(body, 'username', 1, 100),
      displayName: requiredString(body, 'display_name', 1, 100),
      platformRole,
      status: 'active',
      version: 1,
      passwordHash: await argon2.hash(temporaryPassword, { type: argon2.argon2id }),
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    };
    await repository.createUser(user);
    const response = {
      ...userSummary(user),
      status: user.status,
      department: null,
      version: user.version,
    };
    await repository.putIdempotency({
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      route: 'POST:/admin/users',
      key: idempotency.key,
      requestHash: idempotency.requestHash,
      statusCode: 201,
      response,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'admin.user_created',
      resourceType: 'user',
      resourceId: user.id,
      result: 'success',
    });
    return reply.code(201).send(response);
  });

  app.patch('/company-api/v1/admin/users/:user_id', async (request) => {
    const context = await auth(request, true);
    assertAdmin(context);
    const { user_id: userId } = request.params as { user_id: string };
    const target = await repository.getUser(userId);
    if (!target || target.tenantId !== context.user.tenantId) {
      throw new HttpProblem(404, 'user_not_found', 'User was not found');
    }
    const body = objectBody(request.body);
    const patch: Partial<Pick<UserRecord, 'displayName' | 'platformRole' | 'status'>> = {};
    if (body.display_name !== undefined)
      patch.displayName = requiredString(body, 'display_name', 1, 100);
    if (body.platform_role !== undefined) {
      const value = requiredString(body, 'platform_role');
      if (!['admin', 'member'].includes(value))
        throw new HttpProblem(400, 'invalid_platform_role', 'platform_role is invalid');
      patch.platformRole = value as UserRecord['platformRole'];
    }
    if (body.status !== undefined) {
      const value = requiredString(body, 'status');
      if (!['active', 'disabled'].includes(value))
        throw new HttpProblem(400, 'invalid_user_status', 'status is invalid');
      patch.status = value as UserRecord['status'];
    }
    const user = await repository.updateUser(
      userId,
      requiredInteger(body, 'expected_version', 1),
      patch,
    );
    if (user.status === 'disabled') {
      await repository.revokeUserSessions(user.id);
      await options.runnerAdminClient?.stopForUser?.(user.id, 'account_disabled');
    }
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'admin.user_updated',
      resourceType: 'user',
      resourceId: user.id,
      result: 'success',
      details: patch,
    });
    const membership = await repository.getMembership(user.id);
    return {
      ...userSummary(user),
      status: user.status,
      department: membership ? membershipView(membership) : null,
      version: user.version,
    };
  });

  app.post('/company-api/v1/admin/users/:user_id/reset-password', async (request, reply) => {
    const context = await auth(request, true);
    assertAdmin(context);
    const { user_id: userId } = request.params as { user_id: string };
    const body = objectBody(request.body);
    const idempotency = await getIdempotency(
      request,
      context,
      `POST:/admin/users/${userId}/reset-password`,
      body,
    );
    if (idempotency.existing) {
      return reply.code(idempotency.existing.statusCode).send(idempotency.existing.response);
    }
    const user = await repository.getUser(userId);
    if (!user || user.tenantId !== context.user.tenantId) {
      throw new HttpProblem(404, 'user_not_found', 'User was not found');
    }
    const expectedVersion = requiredInteger(body, 'expected_version', 1);
    if (user.version !== expectedVersion)
      throw new HttpProblem(412, 'version_conflict', 'User version does not match');
    const temporaryPassword = requiredSecretString(body, 'temporary_password', 8, 128);
    await repository.replacePassword(
      userId,
      await argon2.hash(temporaryPassword, { type: argon2.argon2id }),
      true,
    );
    await repository.revokeUserSessions(userId);
    await repository.putIdempotency({
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      route: `POST:/admin/users/${userId}/reset-password`,
      key: idempotency.key,
      requestHash: idempotency.requestHash,
      statusCode: 204,
      response: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'admin.password_reset',
      resourceType: 'user',
      resourceId: userId,
      result: 'success',
    });
    return reply.code(204).send();
  });

  app.get('/company-api/v1/admin/departments', async (request) => {
    const context = await auth(request);
    assertAdmin(context);
    const departments = await repository.listDepartments(context.user.tenantId);
    return { items: departments.map(departmentView), next_cursor: null };
  });

  app.post('/company-api/v1/admin/departments', async (request, reply) => {
    const context = await auth(request, true);
    assertAdmin(context);
    const body = objectBody(request.body);
    const idempotency = await getIdempotency(request, context, 'POST:/admin/departments', body);
    if (idempotency.existing)
      return reply.code(idempotency.existing.statusCode).send(idempotency.existing.response);
    const now = new Date();
    const department: DepartmentRecord = {
      id: randomUUID(),
      tenantId: context.user.tenantId,
      name: requiredString(body, 'name', 1, 100),
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await repository.createDepartment(department);
    const response = departmentView(department);
    await repository.putIdempotency({
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      route: 'POST:/admin/departments',
      key: idempotency.key,
      requestHash: idempotency.requestHash,
      statusCode: 201,
      response,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'admin.department_created',
      resourceType: 'department',
      resourceId: department.id,
      result: 'success',
    });
    return reply.code(201).send(response);
  });

  app.put('/company-api/v1/admin/departments/:department_id/members/:user_id', async (request) => {
    const context = await auth(request, true);
    assertAdmin(context);
    const { department_id: departmentId, user_id: userId } = request.params as {
      department_id: string;
      user_id: string;
    };
    const department = await repository.getDepartment(departmentId);
    const user = await repository.getUser(userId);
    if (
      !department ||
      department.tenantId !== context.user.tenantId ||
      !user ||
      user.tenantId !== context.user.tenantId
    ) {
      throw new HttpProblem(
        404,
        'organization_resource_not_found',
        'User or department was not found',
      );
    }
    const body = objectBody(request.body);
    const orgRole = requiredString(body, 'org_role') as MembershipRecord['orgRole'];
    if (!['manager', 'member'].includes(orgRole))
      throw new HttpProblem(400, 'invalid_org_role', 'org_role is invalid');
    const now = new Date();
    const membership = await repository.putMembership(
      {
        departmentId,
        userId,
        orgRole,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      requiredInteger(body, 'expected_version'),
    );
    await repository.revokeUserSessions(userId);
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'admin.membership_updated',
      resourceType: 'department_member',
      resourceId: userId,
      result: 'success',
      details: { department_id: departmentId, org_role: orgRole },
    });
    return membershipView(membership);
  });

  app.get('/company-api/v1/admin/runners', async (request) => {
    const context = await auth(request);
    assertAdmin(context);
    const items = (await options.runnerAdminClient?.list(context.user.tenantId)) ?? [];
    return { items, next_cursor: null };
  });

  app.post('/company-api/v1/admin/runners/:runner_id/stop', async (request, reply) => {
    const context = await auth(request, true);
    assertAdmin(context);
    if (!options.runnerAdminClient)
      throw new HttpProblem(503, 'runner_manager_unavailable', 'Runner Manager is unavailable');
    const { runner_id: runnerId } = request.params as { runner_id: string };
    const body = objectBody(request.body);
    const visible = await options.runnerAdminClient.list(context.user.tenantId);
    if (!visible.some((item) => runnerIdOf(item) === runnerId)) {
      throw new HttpProblem(404, 'runner_not_found', 'Runner was not found');
    }
    const result = await options.runnerAdminClient.stop(
      runnerId,
      requiredString(body, 'reason', 1, 1000),
      requiredInteger(body, 'grace_period_seconds'),
    );
    await audit(request, {
      tenantId: context.user.tenantId,
      actorUserId: context.user.id,
      action: 'runner.stop_requested',
      resourceType: 'runner',
      resourceId: runnerId,
      result: 'success',
    });
    return reply.code(202).send(result);
  });

  const assertServiceToken = (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    if (!options.serviceToken || authorization !== `Bearer ${options.serviceToken}`) {
      throw new HttpProblem(401, 'service_auth_invalid', 'Internal service authentication failed');
    }
    const requestId = request.headers['x-request-id'];
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128) {
      throw new HttpProblem(400, 'request_id_required', 'X-Request-Id is required');
    }
  };

  app.post('/internal/v1/automation-runs', async (request, reply) => {
    assertServiceToken(request);
    const body = objectBody(request.body);
    const purpose = requiredString(body, 'purpose') as AutomationPurpose;
    if (!['task_split', 'task_review', 'daily_rewrite'].includes(purpose)) {
      throw new HttpProblem(400, 'automation_purpose_invalid', 'Automation purpose is invalid');
    }
    const input = body.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpProblem(400, 'automation_input_invalid', 'Automation input must be an object');
    }
    const tenantId = requiredString(body, 'tenant_id');
    const actorUserId = requiredString(body, 'actor_user_id');
    const route = 'POST:/internal/v1/automation-runs';
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new HttpProblem(400, 'idempotency_key_required', 'A valid Idempotency-Key is required');
    }
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const record = await repository.withIdempotencyLock(
      `${tenantId}:${actorUserId}:${route}:${key}`,
      async () => {
        const existing = await repository.getIdempotency(tenantId, actorUserId, route, key);
        if (existing && existing.requestHash !== requestHash) {
          throw new HttpProblem(
            409,
            'idempotency_key_reused',
            'Idempotency-Key was reused with another request',
          );
        }
        if (existing) return existing;
        const run = await automation.create({
          tenant_id: tenantId,
          actor_user_id: actorUserId,
          purpose,
          correlation_id: requiredString(body, 'correlation_id'),
          input: input as Record<string, unknown>,
          output_schema_id: requiredString(body, 'output_schema_id'),
        });
        const created = {
          tenantId,
          actorUserId,
          route,
          key,
          requestHash,
          statusCode: 202,
          response: run,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
        await repository.putIdempotency(created);
        return created;
      },
    );
    return reply.code(record.statusCode).send(record.response);
  });

  app.get('/internal/v1/automation-runs/:run_id', async (request) => {
    assertServiceToken(request);
    const { run_id: runId } = request.params as { run_id: string };
    const run = await automation.get(runId);
    if (!run)
      throw new HttpProblem(404, 'automation_run_not_found', 'Automation run was not found');
    return run;
  });

  return app;
}

function modelConfigFailureCode(error: unknown): string {
  if (error instanceof HttpProblem) return error.code;
  if (error instanceof Error && error.name) return error.name.slice(0, 200);
  return 'model_config_update_failed';
}

function runnerIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}
