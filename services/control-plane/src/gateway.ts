import type { IncomingMessage } from 'node:http';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import WebSocket, { WebSocketServer } from 'ws';

import { deriveRunnerIdentitySecret } from '@company/dsh-runner';

import type { PlatformRepository, UserRecord } from './domain.js';
import { HttpProblem } from './problems.js';
import { authenticate, hashOpaque, parseCookies, SESSION_COOKIE } from './security.js';
import { SessionIndexBridge, type RunnerSessionSnapshot } from './session-index-bridge.js';

const SAFE_METHODS = new Set([
  'host.describe',
  'session.list',
  'session.search',
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession',
  'skill.list',
  'agentPreset.list',
  'agentPreset.select',
  'llm.providers',
  'llm.models',
]);

const EXPLICITLY_DENIED = new Set([
  'host.pickDirectory',
  'host.openPath',
  'host.listDirectory',
  'host.createDirectory',
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
]);

const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;

export function normalizeWebSocketCloseCode(code: number): number {
  if (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999))
  ) {
    return code;
  }
  return 1011;
}

export type LocatedRunner = {
  runnerId: string;
  internalEndpoint: string;
};

export interface DshRunnerLocator {
  ensure(input: {
    tenantId: string;
    userId: string;
    configVersion: number;
    requestId: string;
  }): Promise<LocatedRunner>;
}

export type DshGatewayOptions = {
  repository: PlatformRepository;
  runnerLocator: DshRunnerLocator;
  runnerIdentitySecret: Uint8Array;
  fetch?: typeof globalThis.fetch;
  sessionBridge?: SessionIndexBridge;
  workbenchEntryUrl?: string;
};

type DshEnvelope = {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: Record<string, unknown>;
};

type DshClientResponse = {
  type: 'client-response';
  rpcId: string;
  result:
    | { ok: true; value?: unknown }
    | {
        ok: false;
        error: { code: string; message: string; details: Record<string, unknown> };
      };
};

export function isAllowedDshMethod(method: string): boolean {
  if (
    EXPLICITLY_DENIED.has(method) ||
    method.startsWith('settings.') ||
    method.startsWith('credentials.')
  ) {
    return false;
  }
  return SAFE_METHODS.has(method);
}

export function registerDshGateway(app: FastifyInstance, options: DshGatewayOptions): void {
  const bridge = options.sessionBridge ?? new SessionIndexBridge(options.repository);
  const fetcher = options.fetch ?? globalThis.fetch;

  const locate = async (user: UserRecord, requestId: string): Promise<LocatedRunner> => {
    const runner = await options.repository.withUserConfigLock(user.id, async () => {
      const config = await options.repository.getModelConfig(user.id);
      if (!config) {
        throw new HttpProblem(
          409,
          'model_config_required',
          'Configure a model before opening chat',
        );
      }
      return options.runnerLocator.ensure({
        tenantId: user.tenantId,
        userId: user.id,
        configVersion: config.configVersion,
        requestId,
      });
    });
    const endpoint = new URL(runner.internalEndpoint);
    if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) {
      throw new HttpProblem(
        502,
        'runner_endpoint_invalid',
        'Runner returned an invalid internal endpoint',
      );
    }
    return runner;
  };

  app.get('/chat', async (request, reply) => {
    const context = await authenticate(request, options.repository);
    const runner = await locate(context.user, request.id);
    return proxyStatic(
      fetcher,
      runner.internalEndpoint,
      '/',
      request,
      reply,
      options.workbenchEntryUrl ?? '/workbench',
    );
  });

  app.get('/chat/*', async (request, reply) => {
    const context = await authenticate(request, options.repository);
    const runner = await locate(context.user, request.id);
    const suffix = (request.params as { '*': string })['*'];
    if (suffix.startsWith('api/'))
      throw new HttpProblem(405, 'method_not_allowed', 'Use the DSH RPC transport');
    return proxyStatic(
      fetcher,
      runner.internalEndpoint,
      `/${suffix}`,
      request,
      reply,
      options.workbenchEntryUrl ?? '/workbench',
    );
  });

  app.post('/chat/api/:method', async (request, reply) => {
    const context = await authenticate(request, options.repository);
    const { method } = request.params as { method: string };
    const isResponseCarrier = method === 'respond';
    if (!isResponseCarrier && !isAllowedDshMethod(method)) {
      throw new HttpProblem(
        403,
        'dsh_method_denied',
        'The DSH method is not available in the company profile',
      );
    }
    const envelope = isResponseCarrier
      ? parseClientResponse(request.body)
      : parseEnvelope(request.body, method);
    if (envelope.type === 'client-request') {
      const sessionId = sessionIdFromPayload(envelope.payload);
      if (sessionId && method !== 'session.create')
        await bridge.assertOwned(context.user.id, sessionId);
    }
    const runner = await locate(context.user, request.id);
    const identity = await signRunnerIdentity(
      options.runnerIdentitySecret,
      context.user,
      runner.runnerId,
      request.id,
    );
    const upstream = new URL(`/chat/api/${method}`, runner.internalEndpoint);
    const response = await fetcher(upstream, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${identity}`,
        'x-request-id': request.id,
      },
      body: JSON.stringify(envelope),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PROXY_BODY_BYTES) {
      throw new HttpProblem(
        502,
        'runner_response_too_large',
        'Runner response exceeded the proxy limit',
      );
    }
    const contentType = response.headers.get('content-type');
    if (contentType) reply.header('content-type', contentType);
    reply.code(response.status);
    if (response.ok && contentType?.includes('application/json')) {
      const value = JSON.parse(bytes.toString('utf8')) as unknown;
      if (envelope.type === 'client-request')
        await observeSessionResponse(bridge, context.user, method, envelope.payload, value);
      return reply.send(value);
    }
    return reply.send(bytes);
  });

  registerWebSocketProxy(app, options, locate);
}

function parseEnvelope(value: unknown, pathMethod: string): DshEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpProblem(400, 'dsh_envelope_invalid', 'DSH request envelope must be an object');
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.type !== 'client-request' ||
    typeof envelope.rpcId !== 'string' ||
    envelope.rpcId.length < 1 ||
    envelope.rpcId.length > 256 ||
    envelope.method !== pathMethod ||
    !envelope.payload ||
    typeof envelope.payload !== 'object' ||
    Array.isArray(envelope.payload)
  ) {
    throw new HttpProblem(
      400,
      'dsh_envelope_invalid',
      'DSH request envelope does not match the route',
    );
  }
  return envelope as DshEnvelope;
}

function parseClientResponse(value: unknown): DshClientResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidClientResponse();
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.type !== 'client-response' ||
    typeof envelope.rpcId !== 'string' ||
    envelope.rpcId.length < 1 ||
    envelope.rpcId.length > 256 ||
    !envelope.result ||
    typeof envelope.result !== 'object' ||
    Array.isArray(envelope.result)
  ) {
    throw invalidClientResponse();
  }
  const result = envelope.result as Record<string, unknown>;
  if (result.ok === true) return envelope as DshClientResponse;
  if (
    result.ok !== false ||
    !result.error ||
    typeof result.error !== 'object' ||
    Array.isArray(result.error)
  ) {
    throw invalidClientResponse();
  }
  const error = result.error as Record<string, unknown>;
  if (
    typeof error.code !== 'string' ||
    typeof error.message !== 'string' ||
    !error.details ||
    typeof error.details !== 'object' ||
    Array.isArray(error.details)
  ) {
    throw invalidClientResponse();
  }
  return envelope as DshClientResponse;
}

function invalidClientResponse(): HttpProblem {
  return new HttpProblem(400, 'dsh_envelope_invalid', 'DSH client response envelope is invalid');
}

function sessionIdFromPayload(payload: Record<string, unknown>): string | null {
  const value = payload.sessionId ?? payload.session_id;
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new HttpProblem(400, 'session_id_invalid', 'Session id is invalid');
  }
  return value;
}

async function observeSessionResponse(
  bridge: SessionIndexBridge,
  user: UserRecord,
  method: string,
  payload: Record<string, unknown>,
  response: unknown,
): Promise<void> {
  const value = rpcValue(response);
  if (!value) return;
  if (method === 'session.create' || method === 'session.fork') {
    if (typeof value.sessionId !== 'string') return;
    await bridge.register(
      { tenantId: user.tenantId, userId: user.id },
      {
        sessionId: value.sessionId,
        workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      },
    );
    return;
  }
  if (method === 'session.list' && Array.isArray(value.items)) {
    const snapshots = value.items.flatMap((item): RunnerSessionSnapshot[] => {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as Record<string, unknown>).sessionId !== 'string'
      )
        return [];
      const row = item as Record<string, unknown>;
      return [
        {
          sessionId: row.sessionId as string,
          cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
          lastEventAt: typeof row.updatedAt === 'number' ? new Date(row.updatedAt) : null,
        },
      ];
    });
    await bridge.reconcile({ tenantId: user.tenantId, userId: user.id }, snapshots);
    return;
  }
  const sessionId = sessionIdFromPayload(payload);
  if (sessionId && method === 'session.rename') {
    await bridge.register(
      { tenantId: user.tenantId, userId: user.id },
      {
        sessionId,
        title: typeof value.title === 'string' ? value.title : undefined,
        lastEventPosition: typeof value.seq === 'number' ? value.seq : undefined,
        lastEventAt: new Date(),
      },
    );
  }
}

function rpcValue(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== 'object') return null;
  const result = (response as Record<string, unknown>).result;
  if (!result || typeof result !== 'object' || (result as Record<string, unknown>).ok !== true)
    return null;
  const value = (result as Record<string, unknown>).value;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

async function proxyStatic(
  fetcher: typeof globalThis.fetch,
  endpoint: string,
  path: string,
  request: FastifyRequest,
  reply: FastifyReply,
  workbenchEntryUrl: string,
) {
  const upstream = new URL(endpoint);
  upstream.pathname = path;
  upstream.search = new URL(request.raw.url ?? '/', 'http://gateway.invalid').search;
  const headers = new Headers();
  for (const name of ['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const response = await fetcher(upstream, {
    method: 'GET',
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-range']) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
  let bytes = Buffer.from(await response.arrayBuffer());
  if (response.headers.get('content-type')?.includes('text/html')) {
    bytes = Buffer.from(
      bytes
        .toString('utf8')
        .replace('__COMPANY_WORKBENCH_ENTRY_URL__', escapeHtmlAttribute(workbenchEntryUrl)),
      'utf8',
    );
  }
  return reply.code(response.status).send(bytes);
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

async function signRunnerIdentity(
  secret: Uint8Array,
  user: UserRecord,
  runnerId: string,
  requestId: string,
): Promise<string> {
  if (secret.byteLength < 32)
    throw new Error('Runner identity secret must contain at least 32 bytes');
  return new SignJWT({
    tenant_id: user.tenantId,
    user_id: user.id,
    runner_id: runnerId,
    request_id: requestId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('company-control-plane')
    .setAudience('company-dsh-runner')
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(
      deriveRunnerIdentitySecret(secret, {
        tenantId: user.tenantId,
        userId: user.id,
        runnerId,
      }),
    );
}

function registerWebSocketProxy(
  app: FastifyInstance,
  options: DshGatewayOptions,
  locate: (user: UserRecord, requestId: string) => Promise<LocatedRunner>,
): void {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const onUpgrade = (
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    const path = new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
    if (path !== '/chat/api/events.mux' && path !== '/chat/api/events.host') return;
    void (async () => {
      const user = await authenticateUpgrade(request, options.repository);
      const requestId = validRequestId(request.headers['x-request-id']);
      const runner = await locate(user, requestId);
      const identity = await signRunnerIdentity(
        options.runnerIdentitySecret,
        user,
        runner.runnerId,
        requestId,
      );
      sockets.handleUpgrade(request, socket, head, (browser) => {
        const target = new URL(path, runner.internalEndpoint);
        target.protocol = 'ws:';
        const upstream = new WebSocket(target, {
          headers: { authorization: `Bearer ${identity}`, 'x-request-id': requestId },
          maxPayload: 64 * 1024,
          perMessageDeflate: false,
        });
        browser.on('message', () => browser.close(1008, 'downlink only'));
        upstream.on('message', (data, binary) => {
          if (browser.readyState !== WebSocket.OPEN) return;
          if (browser.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            browser.close(1013, 'backpressure limit');
            upstream.close();
            return;
          }
          browser.send(data, { binary });
        });
        upstream.on('close', (code, reason) => {
          if (browser.readyState !== WebSocket.OPEN) return;
          const safeCode = normalizeWebSocketCloseCode(code);
          browser.close(
            safeCode,
            safeCode === code ? reason.toString() : 'runner websocket closed abnormally',
          );
        });
        upstream.on('error', () => {
          if (browser.readyState === WebSocket.OPEN) browser.close(1011, 'runner websocket failed');
        });
        browser.on('close', () => upstream.close());
        browser.on('error', () => upstream.close());
      });
    })().catch(() => socket.destroy());
  };
  app.server.on('upgrade', onUpgrade);
  app.addHook('onClose', async () => {
    app.server.off('upgrade', onUpgrade);
    sockets.close();
  });
}

async function authenticateUpgrade(
  request: IncomingMessage,
  repository: PlatformRepository,
): Promise<UserRecord> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) throw new Error('authentication required');
  const session = await repository.getWebSessionByTokenHash(hashOpaque(token));
  const now = new Date();
  if (
    !session ||
    session.revokedAt ||
    session.idleExpiresAt <= now ||
    session.absoluteExpiresAt <= now
  ) {
    throw new Error('session expired');
  }
  const user = await repository.getUser(session.userId);
  if (!user || user.status !== 'active') throw new Error('account unavailable');
  return user;
}

function validRequestId(value: string | string[] | undefined): string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128
    ? value
    : crypto.randomUUID();
}
