import { SignJWT } from 'jose';

import { FakeAutomationProvider } from '../src/adapters/automation/fake-automation-provider.js';
import { FakeBusinessRepository } from '../src/adapters/fake/fake-business-repository.js';
import { buildBusinessApp } from '../src/app.js';
import type { ActorContext } from '../src/domain/models.js';
import { FixedClock } from '../src/ports/clock.js';

export const SECRET = 'test-only-actor-token-secret-at-least-32-characters';
export const ISSUER = 'company-control-plane';
export const TENANT = '00000000-0000-4000-8000-000000000001';
export const DEV_DEPARTMENT = '00000000-0000-4000-8000-000000000101';
export const PRODUCT_DEPARTMENT = '00000000-0000-4000-8000-000000000102';
export const DEV_MANAGER = '00000000-0000-4000-8000-000000001002';
export const DEV_A = '00000000-0000-4000-8000-000000001003';
export const DEV_B = '00000000-0000-4000-8000-000000001004';
export const PRODUCT_MANAGER = '00000000-0000-4000-8000-000000001005';
export const ADMIN = '00000000-0000-4000-8000-000000001001';

export const actors = {
  manager: actor(DEV_MANAGER, 'member', DEV_DEPARTMENT, 'manager'),
  devA: actor(DEV_A, 'member', DEV_DEPARTMENT, 'member'),
  devB: actor(DEV_B, 'member', DEV_DEPARTMENT, 'member'),
  productManager: actor(PRODUCT_MANAGER, 'member', PRODUCT_DEPARTMENT, 'manager'),
  admin: actor(ADMIN, 'admin', null, null),
};

function actor(
  userId: string,
  platformRole: ActorContext['platformRole'],
  departmentId: string | null,
  orgRole: ActorContext['orgRole'],
): ActorContext {
  return {
    issuer: ISSUER,
    tenantId: TENANT,
    userId,
    sessionId: `10000000-0000-4000-8000-${userId.slice(-12)}`,
    platformRole,
    departmentId,
    orgRole,
    requestId: 'request-0001',
  };
}

export function createTestContext(now = '2026-08-18T10:00:00Z') {
  const repository = new FakeBusinessRepository();
  const clock = new FixedClock(new Date(now));
  const automation = new FakeAutomationProvider(clock);
  const app = buildBusinessApp({
    repository,
    automation,
    clock,
    actorTokenSecret: SECRET,
    actorTokenIssuer: ISSUER,
  });
  return { app, repository, clock, automation };
}

export async function authHeaders(
  actorContext: ActorContext,
  extra: Record<string, string> = {},
  lifetimeSeconds = 60,
): Promise<Record<string, string>> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    tenant_id: actorContext.tenantId,
    user_id: actorContext.userId,
    session_id: actorContext.sessionId,
    platform_role: actorContext.platformRole,
    department_id: actorContext.departmentId,
    org_role: actorContext.orgRole,
    request_id: actorContext.requestId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('company-business-api')
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSeconds)
    .sign(new TextEncoder().encode(SECRET));
  return {
    authorization: `Bearer ${token}`,
    'x-request-id': actorContext.requestId,
    ...extra,
  };
}
