import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildControlPlane } from './app.js';
import { isBusinessApiRoute, registerBusinessGateway } from './business-gateway.js';
import type { DepartmentRecord, MembershipRecord, UserRecord } from './domain.js';
import { MemoryPlatformRepository } from './memory-repository.js';
import { createSessionRecord, SecretCipher } from './security.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const departmentId = '00000000-0000-4000-8000-000000000101';
const actorSecret = 'test-only-actor-token-secret-at-least-32-characters';
const actorIssuer = 'company-control-plane';
const businessApiUrl = 'http://business-api:8082';
const issuedAt = new Date('2026-08-21T08:00:00.000Z');
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Business Gateway', () => {
  it('recognizes only the frozen Business API method and path combinations', () => {
    const accepted = [
      ['GET', '/company-api/v1/knowledge/categories'],
      ['POST', `/company-api/v1/knowledge/documents/${randomUUID()}/archive`],
      ['POST', '/company-api/v1/requirements'],
      ['PATCH', `/company-api/v1/requirements/${randomUUID()}`],
      ['POST', `/company-api/v1/tasks/${randomUUID()}/submissions`],
      ['GET', `/company-api/v1/automation-operations/${randomUUID()}`],
      ['DELETE', '/company-api/v1/daily-reports/2026-08-21'],
      ['GET', `/company-api/v1/departments/${departmentId}/daily-reports`],
    ] as const;
    for (const [method, path] of accepted) expect(isBusinessApiRoute(method, path)).toBe(true);

    const rejected = [
      ['GET', '/company-api/v1/me'],
      ['GET', '/company-api/v1/sessions'],
      ['GET', '/company-api/v1/admin/runners'],
      ['POST', '/company-api/v1/tasks'],
      ['GET', `/company-api/v1/requirements/${randomUUID()}/split-runs`],
      ['GET', '/company-api/v1/knowledge/unknown'],
    ] as const;
    for (const [method, path] of rejected) expect(isBusinessApiRoute(method, path)).toBe(false);
  });

  it('keeps Platform API local and rejects missing Session or mutation CSRF before fetch', async () => {
    const upstream = vi.fn(async () => Response.json({ unexpected: true }));
    const fixture = createFixture({ fetch: upstream });

    const local = await fixture.app.inject({
      method: 'GET',
      url: '/company-api/v1/me',
      headers: { cookie: sessionCookies(fixture) },
    });
    expect(local.statusCode).toBe(200);

    const unauthenticated = await fixture.app.inject({
      method: 'GET',
      url: '/company-api/v1/requirements',
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ code: 'authentication_required' });

    const missingCsrf = await fixture.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: { cookie: sessionCookies(fixture) },
      payload: { title: 'Gateway test' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: 'csrf_invalid' });

    const unknown = await fixture.app.inject({
      method: 'GET',
      url: '/company-api/v1/knowledge/unknown',
      headers: { cookie: sessionCookies(fixture) },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'business_route_not_found' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('strips browser identity headers and signs request-bound Actor claims', async () => {
    let captured: { url: string; init: RequestInit; headers: Headers } | undefined;
    const fixture = createFixture({
      fetch: async (url, init = {}) => {
        captured = { url: String(url), init, headers: new Headers(init.headers) };
        return new Response(JSON.stringify({ id: 'created-requirement' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const requestId = 'browser-request-0001';
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements?view=mine',
      headers: {
        cookie: sessionCookies(fixture),
        authorization: 'Bearer browser-forged-token',
        'x-csrf-token': fixture.csrfToken,
        'x-request-id': requestId,
        'idempotency-key': 'gateway-idempotency-key',
        accept: 'application/json',
        'x-tenant-id': 'forged-tenant',
        'x-user-id': 'forged-user',
        'x-department-id': 'forged-department',
        'x-platform-role': 'admin',
        'x-org-role': 'manager',
        'x-actor-token': 'forged-actor',
        'x-forwarded-for': '127.0.0.1',
        'x-internal-identity': 'forged-internal-identity',
      },
      payload: { title: 'Gateway request' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(captured?.url).toBe(`${businessApiUrl}/company-api/v1/requirements?view=mine`);
    expect(captured?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(captured?.init.body).toBe(JSON.stringify({ title: 'Gateway request' }));
    expect(captured?.headers.get('accept')).toBe('application/json');
    expect(captured?.headers.get('content-type')).toBe('application/json');
    expect(captured?.headers.get('idempotency-key')).toBe('gateway-idempotency-key');
    expect(captured?.headers.get('cookie')).toBeNull();
    expect(captured?.headers.get('x-csrf-token')).toBeNull();
    for (const name of [
      'x-tenant-id',
      'x-user-id',
      'x-department-id',
      'x-platform-role',
      'x-org-role',
      'x-actor-token',
      'x-forwarded-for',
      'x-internal-identity',
    ]) {
      expect(captured?.headers.get(name)).toBeNull();
    }

    const authorization = captured?.headers.get('authorization');
    expect(authorization).toMatch(/^Bearer /u);
    expect(authorization).not.toContain('browser-forged-token');
    expect(captured?.headers.get('x-request-id')).toBe(requestId);
    const verified = await jwtVerify(
      authorization!.slice('Bearer '.length),
      new TextEncoder().encode(actorSecret),
      {
        issuer: actorIssuer,
        audience: 'company-business-api',
        algorithms: ['HS256'],
        currentDate: issuedAt,
      },
    );
    expect(verified.protectedHeader).toMatchObject({ alg: 'HS256', typ: 'JWT' });
    expect(Object.keys(verified.payload).sort()).toEqual(
      [
        'aud',
        'department_id',
        'exp',
        'iat',
        'iss',
        'org_role',
        'platform_role',
        'request_id',
        'session_id',
        'tenant_id',
        'user_id',
      ].sort(),
    );
    expect(verified.payload).toMatchObject({
      iss: actorIssuer,
      aud: 'company-business-api',
      tenant_id: tenantId,
      user_id: userId,
      session_id: fixture.sessionId,
      platform_role: 'member',
      department_id: departmentId,
      org_role: 'member',
      request_id: requestId,
      iat: Math.floor(issuedAt.getTime() / 1000),
      exp: Math.floor(issuedAt.getTime() / 1000) + 60,
    });
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(60);
  });

  it('revokes the Session and refuses upstream access for a disabled account', async () => {
    const upstream = vi.fn(async () => Response.json({ unexpected: true }));
    const fixture = createFixture({ fetch: upstream, userStatus: 'disabled' });

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/company-api/v1/tasks',
      headers: { cookie: sessionCookies(fixture) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'account_unavailable' });
    expect(fixture.repository.webSessions.get(fixture.sessionId)?.revokedAt).toBeInstanceOf(Date);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('preserves upstream Problem Details status and content type but owns X-Request-Id', async () => {
    const problem = {
      type: 'https://company.example/problems/invalid_request',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'Business validation failed.',
      code: 'invalid_request',
      request_id: 'gateway-problem-0001',
    };
    const fixture = createFixture({
      fetch: async () =>
        new Response(JSON.stringify(problem), {
          status: 422,
          headers: {
            'content-type': 'application/problem+json',
            'x-request-id': 'untrusted-upstream-id',
          },
        }),
    });
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/company-api/v1/knowledge/documents?scope=company&limit=10',
      headers: { cookie: sessionCookies(fixture), 'x-request-id': 'gateway-problem-0001' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['x-request-id']).toBe('gateway-problem-0001');
    expect(response.json()).toEqual(problem);
  });

  it('collapses transport and non-JSON upstream failures without leaking sensitive data', async () => {
    const sensitive = `${actorSecret} ${businessApiUrl} browser-forged-token`;
    const transport = createFixture({
      fetch: async () => {
        throw new Error(sensitive);
      },
    });
    const transportResponse = await transport.app.inject({
      method: 'GET',
      url: '/company-api/v1/tasks',
      headers: { cookie: sessionCookies(transport) },
    });
    expect(transportResponse.statusCode).toBe(502);
    expect(transportResponse.json()).toMatchObject({ code: 'business_api_unavailable' });
    expect(transportResponse.body).not.toContain(actorSecret);
    expect(transportResponse.body).not.toContain(businessApiUrl);
    expect(transportResponse.body).not.toContain('browser-forged-token');

    const malformed = createFixture({
      fetch: async () =>
        new Response(sensitive, { status: 500, headers: { 'content-type': 'text/plain' } }),
    });
    const malformedResponse = await malformed.app.inject({
      method: 'GET',
      url: '/company-api/v1/tasks',
      headers: { cookie: sessionCookies(malformed) },
    });
    expect(malformedResponse.statusCode).toBe(502);
    expect(malformedResponse.json()).toMatchObject({ code: 'business_api_invalid_response' });
    expect(malformedResponse.body).not.toContain(sensitive);
  });

  it('rejects oversized JSON before contacting Business API', async () => {
    const upstream = vi.fn(async () => Response.json({ unexpected: true }));
    const fixture = createFixture({ fetch: upstream });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/company-api/v1/requirements',
      headers: {
        cookie: sessionCookies(fixture),
        'x-csrf-token': fixture.csrfToken,
      },
      payload: { title: 'x'.repeat(1024 * 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'request_body_too_large' });
    expect(upstream).not.toHaveBeenCalled();
  });
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture(options: {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  userStatus?: UserRecord['status'];
}) {
  const repository = new MemoryPlatformRepository(tenantId);
  const now = new Date();
  const user: UserRecord = {
    id: userId,
    tenantId,
    username: 'dev_a',
    displayName: 'Dev A',
    platformRole: 'member',
    status: options.userStatus ?? 'active',
    version: 1,
    passwordHash: 'unused',
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
  };
  const department: DepartmentRecord = {
    id: departmentId,
    tenantId,
    name: 'Development',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const membership: MembershipRecord = {
    departmentId,
    userId,
    orgRole: 'member',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  repository.users.set(user.id, user);
  repository.departments.set(department.id, department);
  repository.memberships.set(user.id, membership);
  const session = createSessionRecord(user.id, now);
  repository.webSessions.set(session.record.id, session.record);
  const app = buildControlPlane({
    repository,
    secretCipher: new SecretCipher(Buffer.alloc(32, 9)),
  });
  registerBusinessGateway(app, {
    repository,
    businessApiUrl,
    actorTokenSecret: actorSecret,
    actorTokenIssuer: actorIssuer,
    fetch: options.fetch,
    now: () => issuedAt,
  });
  apps.push(app);
  return {
    app,
    repository,
    token: session.token,
    csrfToken: session.csrfToken,
    sessionId: session.record.id,
  };
}

function sessionCookies(fixture: Fixture): string {
  return `company_session=${fixture.token}; company_csrf=${fixture.csrfToken}`;
}
