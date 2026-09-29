import type { FastifyInstance } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveRunnerIdentitySecret } from '@company/dsh-runner';

import { buildControlPlane } from './app.js';
import { businessPath, registerAgentToolGateway } from './agent-tool-gateway.js';
import type { DepartmentRecord, MembershipRecord, UserRecord } from './domain.js';
import { MemoryPlatformRepository } from './memory-repository.js';
import { SecretCipher } from './security.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const departmentId = '00000000-0000-4000-8000-000000000101';
const runnerId = '00000000-0000-4000-8000-000000000010';
const requestId = '00000000-0000-4000-8000-000000000020';
const rootSecret = Buffer.alloc(32, 8);
const actorSecret = 'test-only-actor-token-secret-at-least-32-characters';
const now = new Date('2026-08-23T08:00:00.000Z');
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Agent Tool Gateway', () => {
  it('maps only normalized queries to fixed Business API GET paths', () => {
    expect(businessPath({ resource: 'tasks', view: 'incomplete', limit: 20 }, departmentId)).toBe(
      '/company-api/v1/tasks?view=incomplete&limit=20',
    );
    expect(
      businessPath({ resource: 'department_daily_reports', date: '2026-08-23' }, departmentId),
    ).toBe(`/company-api/v1/departments/${departmentId}/daily-reports?date=2026-08-23`);
    expect(
      businessPath(
        {
          resource: 'daily_report',
          work_date: '2026-08-23',
          scope: 'task',
          task_id: runnerId,
        },
        departmentId,
      ),
    ).toBe(`/company-api/v1/daily-reports/2026-08-23?scope=task&task_id=${runnerId}`);
  });

  it('uses the active Runner identity and current membership to sign a read-only request', async () => {
    let captured: { url: string; init: RequestInit; headers: Headers } | undefined;
    const fixture = createFixture({
      orgRole: 'manager',
      fetch: async (url, init = {}) => {
        captured = { url: String(url), init, headers: new Headers(init.headers) };
        return Response.json({ items: [{ work_date: '2026-08-23' }], next_cursor: null });
      },
    });
    const token = await runnerToken();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/internal/v1/agent-tools/query-company-system',
      headers: { authorization: `Bearer ${token}`, 'x-request-id': requestId },
      payload: { resource: 'department_daily_reports', date: '2026-08-23' },
    });
    expect(response.statusCode).toBe(200);
    expect(captured?.url).toBe(
      `http://business-api:3102/company-api/v1/departments/${departmentId}/daily-reports?date=2026-08-23`,
    );
    expect(captured?.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(captured?.init.body).toBeUndefined();
    const actor = await jwtVerify(
      captured!.headers.get('authorization')!.slice('Bearer '.length),
      new TextEncoder().encode(actorSecret),
      {
        issuer: 'company-control-plane',
        audience: 'company-business-api',
        algorithms: ['HS256'],
        currentDate: now,
      },
    );
    expect(actor.payload).toMatchObject({
      tenant_id: tenantId,
      user_id: userId,
      session_id: runnerId,
      department_id: departmentId,
      org_role: 'manager',
      request_id: requestId,
    });
  });

  it('rejects forged identities, inactive Runners, and manager-only queries before fetch', async () => {
    const upstream = vi.fn(async () => Response.json({ unexpected: true }));
    const member = createFixture({ orgRole: 'member', fetch: upstream });
    const validToken = await runnerToken();
    const forbidden = await member.app.inject({
      method: 'POST',
      url: '/internal/v1/agent-tools/query-company-system',
      headers: { authorization: `Bearer ${validToken}`, 'x-request-id': requestId },
      payload: { resource: 'department_daily_reports' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'department_manager_required' });

    const forgedArgument = await member.app.inject({
      method: 'POST',
      url: '/internal/v1/agent-tools/query-company-system',
      headers: { authorization: `Bearer ${validToken}`, 'x-request-id': requestId },
      payload: { resource: 'tasks', user_id: userId },
    });
    expect(forgedArgument.statusCode).toBe(400);
    expect(forgedArgument.json()).toMatchObject({ code: 'agent_tool_input_invalid' });

    const wrongRequest = await member.app.inject({
      method: 'POST',
      url: '/internal/v1/agent-tools/query-company-system',
      headers: { authorization: `Bearer ${validToken}`, 'x-request-id': crypto.randomUUID() },
      payload: { resource: 'tasks' },
    });
    expect(wrongRequest.statusCode).toBe(401);

    const inactive = createFixture({ orgRole: 'manager', fetch: upstream, runnerState: 'stopped' });
    const inactiveResponse = await inactive.app.inject({
      method: 'POST',
      url: '/internal/v1/agent-tools/query-company-system',
      headers: { authorization: `Bearer ${validToken}`, 'x-request-id': requestId },
      payload: { resource: 'tasks', user_id: userId },
    });
    expect(inactiveResponse.statusCode).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

function createFixture(options: {
  orgRole: MembershipRecord['orgRole'];
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  runnerState?: string;
}) {
  const repository = new MemoryPlatformRepository(tenantId);
  const user: UserRecord = {
    id: userId,
    tenantId,
    username: 'dev_a',
    displayName: 'Dev A',
    platformRole: 'member',
    status: 'active',
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
  repository.users.set(user.id, user);
  repository.departments.set(department.id, department);
  repository.memberships.set(user.id, {
    departmentId,
    userId,
    orgRole: options.orgRole,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const app = buildControlPlane({
    repository,
    secretCipher: new SecretCipher(Buffer.alloc(32, 9)),
  });
  registerAgentToolGateway(app, {
    repository,
    runnerRegistry: {
      list: async () => [
        {
          id: runnerId,
          tenant_id: tenantId,
          user_id: userId,
          state: options.runnerState ?? 'ready',
        },
      ],
    },
    runnerIdentityRootSecret: rootSecret,
    businessApiUrl: 'http://business-api:3102',
    actorTokenSecret: actorSecret,
    fetch: options.fetch,
    now: () => now,
  });
  apps.push(app);
  return { app };
}

function runnerToken(): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    tenant_id: tenantId,
    user_id: userId,
    runner_id: runnerId,
    request_id: requestId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('company-dsh-runner')
    .setAudience('company-agent-tool-gateway')
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + 60)
    .sign(deriveRunnerIdentitySecret(rootSecret, { tenantId, userId, runnerId }));
}
