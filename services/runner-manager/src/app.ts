import { createHash, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { RunnerRecord } from './domain.js';
import { RunnerBusyError, RunnerManager, RunnerNotFoundError } from './manager.js';

type Options = { manager: RunnerManager; serviceToken: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function problem(status: number, code: string, detail: string, requestId: string) {
  return {
    type: `https://company.invalid/problems/${code}`,
    title: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Request Failed',
    status,
    detail,
    code,
    request_id: requestId,
  };
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('invalid_request', 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new RequestError('invalid_request', 'Request body contains unknown fields');
  }
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new RequestError('invalid_request', `${name} must be a UUID`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RequestError(
      'invalid_request',
      `${name} must be an integer in range ${minimum}-${maximum}`,
    );
  }
  return value as number;
}

function string(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
    throw new RequestError('invalid_request', `${name} must be a non-empty string`);
  }
  return value.trim();
}

function runnerDetail(record: RunnerRecord) {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    user_id: record.userId,
    state: record.state,
    health: record.health,
    internal_endpoint: record.internalEndpoint,
    active_runs: record.activeRuns,
    image_version: record.imageVersion,
    config_version: record.configVersion,
    lease_expires_at: record.leaseExpiresAt?.toISOString() ?? null,
    last_activity_at: record.lastActivityAt?.toISOString() ?? null,
  };
}

export function buildRunnerManager(options: Options): FastifyInstance {
  const idempotency = new Map<string, { hash: string; status: number; response: unknown }>();
  const app = Fastify({
    logger: false,
    genReqId: (request) => {
      const value = request.headers['x-request-id'];
      return typeof value === 'string' ? value : randomUUID();
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${options.serviceToken}`) {
      return reply
        .code(401)
        .type('application/problem+json')
        .send(
          problem(
            401,
            'service_auth_invalid',
            'Internal service authentication failed',
            request.id,
          ),
        );
    }
    const requestId = request.headers['x-request-id'];
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128) {
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem(400, 'request_id_required', 'X-Request-Id is required', request.id));
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof RequestError
        ? error.status
        : error instanceof RunnerNotFoundError
          ? 404
          : error instanceof RunnerBusyError
            ? 409
            : 500;
    const code =
      error instanceof RequestError
        ? error.code
        : error instanceof RunnerNotFoundError
          ? 'runner_not_found'
          : error instanceof RunnerBusyError
            ? 'runner_busy'
            : 'runner_operation_failed';
    const message = error instanceof Error ? error.message : 'Runner operation failed';
    void reply
      .code(status)
      .type('application/problem+json')
      .send(problem(status, code, message, request.id));
  });

  const runIdempotent = async <T>(
    request: FastifyRequest,
    route: string,
    body: Record<string, unknown>,
    status: number,
    action: () => Promise<T>,
  ): Promise<{ status: number; response: T }> => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new RequestError('idempotency_key_required', 'A valid Idempotency-Key is required');
    }
    const scope = `${route}:${key}`;
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const existing = idempotency.get(scope);
    if (existing) {
      if (existing.hash !== hash) {
        throw new RequestError(
          'idempotency_key_reused',
          'Idempotency-Key was reused with another request',
          409,
        );
      }
      return { status: existing.status, response: existing.response as T };
    }
    const response = await action();
    idempotency.set(scope, { hash, status, response });
    return { status, response };
  };

  app.post('/internal/v1/runners/ensure', async (request, reply) => {
    const body = bodyObject(request.body);
    exactKeys(body, ['tenant_id', 'user_id', 'config_version']);
    const result = await runIdempotent(request, 'POST:/runners/ensure', body, 200, async () =>
      runnerDetail(
        await options.manager.ensure({
          tenantId: uuid(body.tenant_id, 'tenant_id'),
          userId: uuid(body.user_id, 'user_id'),
          configVersion: integer(body.config_version, 'config_version', 1),
        }),
      ),
    );
    return reply.code(result.status).send(result.response);
  });

  app.get('/internal/v1/runners', async () => ({
    items: (await options.manager.list()).map(runnerDetail),
  }));

  app.get('/internal/v1/runners/:runner_id', async (request) => {
    const { runner_id: runnerId } = request.params as { runner_id: string };
    return runnerDetail(await options.manager.get(uuid(runnerId, 'runner_id')));
  });

  app.post('/internal/v1/runners/:runner_id/stop', async (request, reply) => {
    const { runner_id: runnerId } = request.params as { runner_id: string };
    const body = bodyObject(request.body);
    exactKeys(body, ['reason', 'grace_period_seconds']);
    const result = await runIdempotent(
      request,
      `POST:/runners/${runnerId}/stop`,
      body,
      202,
      async () => {
        await options.manager.stop(
          uuid(runnerId, 'runner_id'),
          string(body.reason, 'reason', 1000),
          integer(body.grace_period_seconds, 'grace_period_seconds', 0, 300),
        );
        return { operation_id: randomUUID(), status: 'accepted' as const };
      },
    );
    return reply.code(result.status).send(result.response);
  });

  app.post('/internal/v1/runners/:runner_id/reconcile', async (request, reply) => {
    const { runner_id: runnerId } = request.params as { runner_id: string };
    const body = bodyObject(request.body);
    exactKeys(body, ['reason']);
    string(body.reason, 'reason', 1000);
    const result = await runIdempotent(
      request,
      `POST:/runners/${runnerId}/reconcile`,
      body,
      200,
      async () => runnerDetail(await options.manager.reconcile(uuid(runnerId, 'runner_id'))),
    );
    return reply.code(result.status).send(result.response);
  });

  return app;
}
