import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DisabledAutomationProvider } from '../src/adapters/automation/disabled-automation-provider.js';
import { buildBusinessApp } from '../src/app.js';
import { FixedClock } from '../src/ports/clock.js';
import { FakeBusinessRepository } from '../src/adapters/fake/fake-business-repository.js';
import { actors, authHeaders, ISSUER, SECRET } from './helpers.js';

describe('disabled production providers', () => {
  it('keeps core business routes available and returns an explicit 503 for Knowledge', async () => {
    const app = buildBusinessApp({
      repository: new FakeBusinessRepository(),
      automation: new DisabledAutomationProvider(),
      clock: new FixedClock(new Date('2026-08-23T10:00:00Z')),
      actorTokenSecret: SECRET,
      actorTokenIssuer: ISSUER,
      knowledgeEnabled: false,
    });

    try {
      const headers = await authHeaders(actors.devA);
      const tasks = await app.inject({
        method: 'GET',
        url: '/company-api/v1/tasks?view=assigned_to_me&limit=20',
        headers,
      });
      const knowledge = await app.inject({
        method: 'GET',
        url: '/company-api/v1/knowledge/categories?scope=company',
        headers,
      });

      expect(tasks.statusCode).toBe(200);
      expect(knowledge.statusCode).toBe(503);
      expect(knowledge.json()).toMatchObject({ code: 'dependency_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('fails automation calls without creating a fake run', async () => {
    const provider = new DisabledAutomationProvider();
    await expect(
      provider.start({
        tenantId: actors.devA.tenantId,
        actorUserId: actors.devA.userId,
        kind: 'daily_rewrite',
        correlationId: randomUUID(),
        input: {},
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'dependency_unavailable' });
  });
});
