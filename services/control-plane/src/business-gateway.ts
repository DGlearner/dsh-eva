import { Buffer } from 'node:buffer';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';

import type { AuthContext, PlatformRepository } from './domain.js';
import { HttpProblem } from './problems.js';
import { authenticate } from './security.js';

const ACTOR_TOKEN_AUDIENCE = 'company-business-api';
const DEFAULT_ACTOR_TOKEN_ISSUER = 'company-control-plane';
const ACTOR_TOKEN_LIFETIME_SECONDS = 60;
const MAX_BUSINESS_REQUEST_BYTES = 1024 * 1024;
const MAX_BUSINESS_RESPONSE_BYTES = 4 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type BusinessGatewayOptions = {
  repository: PlatformRepository;
  businessApiUrl: string;
  actorTokenSecret: string;
  actorTokenIssuer?: string;
  fetch?: FetchLike;
  now?: () => Date;
};

type RouteRule = { methods: ReadonlySet<string>; path: RegExp };

const route = (methods: string[], path: RegExp): RouteRule => ({
  methods: new Set(methods),
  path,
});

const BUSINESS_ROUTES: RouteRule[] = [
  route(['GET'], /^\/company-api\/v1\/knowledge\/(?:categories|documents)$/u),
  route(['POST'], /^\/company-api\/v1\/knowledge\/uploads$/u),
  route(['GET'], /^\/company-api\/v1\/knowledge\/uploads\/[^/]+$/u),
  route(['POST'], /^\/company-api\/v1\/knowledge\/documents\/[^/]+\/(?:archive|restore|reindex)$/u),
  route(['GET', 'POST'], /^\/company-api\/v1\/requirements$/u),
  route(['GET', 'PATCH'], /^\/company-api\/v1\/requirements\/[^/]+$/u),
  route(
    ['POST'],
    /^\/company-api\/v1\/requirements\/[^/]+\/(?:split-runs|apply-split|publish|cancel)$/u,
  ),
  route(['GET'], /^\/company-api\/v1\/tasks$/u),
  route(['GET'], /^\/company-api\/v1\/tasks\/[^/]+$/u),
  route(
    ['POST'],
    /^\/company-api\/v1\/tasks\/[^/]+\/(?:transitions|submissions|review-runs|accept|return)$/u,
  ),
  route(['GET'], /^\/company-api\/v1\/automation-operations\/[^/]+$/u),
  route(['GET'], /^\/company-api\/v1\/daily-reports$/u),
  route(['GET', 'PUT', 'DELETE'], /^\/company-api\/v1\/daily-reports\/[^/]+$/u),
  route(
    ['POST'],
    /^\/company-api\/v1\/daily-reports\/[^/]+\/(?:publish|rewrite-runs|apply-rewrite)$/u,
  ),
  route(['GET'], /^\/company-api\/v1\/departments\/[^/]+\/daily-reports$/u),
];

export function isBusinessApiRoute(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return BUSINESS_ROUTES.some(
    (candidate) => candidate.methods.has(normalizedMethod) && candidate.path.test(pathname),
  );
}

export function registerBusinessGateway(
  app: FastifyInstance,
  options: BusinessGatewayOptions,
): void {
  const businessApi = parseBusinessApiUrl(options.businessApiUrl);
  if (options.actorTokenSecret.length < 32) {
    throw new Error('ACTOR_TOKEN_SECRET must contain at least 32 characters');
  }
  const issuer = options.actorTokenIssuer ?? DEFAULT_ACTOR_TOKEN_ISSUER;
  if (!issuer.trim()) throw new Error('ACTOR_TOKEN_ISSUER must not be empty');
  const signingKey = new TextEncoder().encode(options.actorTokenSecret);
  const fetchUpstream = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const contexts = new WeakMap<FastifyRequest, AuthContext>();

  app.route({
    method: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    url: '/company-api/v1/*',
    bodyLimit: MAX_BUSINESS_REQUEST_BYTES,
    onRequest: async (request) => {
      const publicUrl = parsePublicRequestUrl(request);
      if (!isBusinessApiRoute(request.method, publicUrl.pathname)) {
        throw new HttpProblem(404, 'business_route_not_found', 'Business API route was not found');
      }
      contexts.set(
        request,
        await authenticate(request, options.repository, {
          requireCsrf: isMutation(request.method),
        }),
      );
    },
    handler: async (request, reply) => {
      const context = contexts.get(request);
      if (!context)
        throw new HttpProblem(500, 'internal_error', 'Authentication context is missing');
      const publicUrl = parsePublicRequestUrl(request);
      const requestBody = serializeRequestBody(request);
      const actorToken = await signActorToken(context, request.id, signingKey, issuer, now());
      const headers = upstreamHeaders(request, actorToken, requestBody !== undefined);
      const upstreamUrl = new URL(`${publicUrl.pathname}${publicUrl.search}`, businessApi.origin);

      let response: Response;
      try {
        response = await fetchUpstream(upstreamUrl, {
          method: request.method,
          headers,
          body: requestBody,
          redirect: 'manual',
        });
      } catch {
        throw new HttpProblem(
          502,
          'business_api_unavailable',
          'Business API is temporarily unavailable',
        );
      }
      return sendUpstreamResponse(response, reply);
    },
  });
}

function parseBusinessApiUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('BUSINESS_API_URL must be a valid absolute URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('BUSINESS_API_URL must be an HTTP(S) origin without credentials or a path');
  }
  return url;
}

function parsePublicRequestUrl(request: FastifyRequest): URL {
  const rawUrl = request.raw.url ?? request.url;
  return new URL(rawUrl, 'http://control-plane.invalid');
}

function isMutation(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function serializeRequestBody(request: FastifyRequest): string | undefined {
  if (request.body === undefined) return undefined;
  const contentType = singleHeader(request.headers['content-type']);
  if (!contentType || !isJsonContentType(contentType)) {
    throw new HttpProblem(415, 'content_type_unsupported', 'Business API requests require JSON');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(request.body);
  } catch {
    throw new HttpProblem(400, 'invalid_request', 'Request body is not valid JSON');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BUSINESS_REQUEST_BYTES) {
    throw new HttpProblem(413, 'request_body_too_large', 'Business API request body is too large');
  }
  return serialized;
}

function upstreamHeaders(request: FastifyRequest, actorToken: string, hasBody: boolean): Headers {
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'idempotency-key'] as const) {
    const value = singleHeader(request.headers[name]);
    if (value) headers.set(name, value);
  }
  if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('authorization', `Bearer ${actorToken}`);
  headers.set('x-request-id', request.id);
  return headers;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function signActorToken(
  context: AuthContext,
  requestId: string,
  signingKey: Uint8Array,
  issuer: string,
  issuedAt: Date,
): Promise<string> {
  const nowSeconds = Math.floor(issuedAt.getTime() / 1000);
  return new SignJWT({
    tenant_id: context.user.tenantId,
    user_id: context.user.id,
    session_id: context.session.id,
    platform_role: context.user.platformRole,
    department_id: context.membership?.departmentId ?? null,
    org_role: context.membership?.orgRole ?? null,
    request_id: requestId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(ACTOR_TOKEN_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ACTOR_TOKEN_LIFETIME_SECONDS)
    .sign(signingKey);
}

async function sendUpstreamResponse(
  response: Response,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (response.status >= 300 && response.status < 400) {
    throw new HttpProblem(502, 'business_api_invalid_response', 'Business API returned a redirect');
  }
  if (response.status === 204) return reply.code(204).send();

  const contentType = response.headers.get('content-type');
  if (!contentType || !isJsonContentType(contentType)) {
    throw new HttpProblem(
      502,
      'business_api_invalid_response',
      'Business API returned an invalid response',
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BUSINESS_RESPONSE_BYTES) {
    throw new HttpProblem(
      502,
      'business_api_invalid_response',
      'Business API response is too large',
    );
  }
  let payload: Buffer;
  try {
    payload = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new HttpProblem(
      502,
      'business_api_invalid_response',
      'Business API response could not be read',
    );
  }
  if (payload.byteLength > MAX_BUSINESS_RESPONSE_BYTES) {
    throw new HttpProblem(
      502,
      'business_api_invalid_response',
      'Business API response is too large',
    );
  }
  return reply.code(response.status).type(contentType).send(payload);
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

export type { BusinessGatewayOptions };
