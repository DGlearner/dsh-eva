import { afterEach, describe, expect, it } from 'vitest';

import { actors, authHeaders, createTestContext } from './helpers.js';

const contexts: ReturnType<typeof createTestContext>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ app }) => app.close()));
});

describe('Business API contract surface', () => {
  it('registers every frozen Business API method and path', async () => {
    const context = createTestContext();
    contexts.push(context);
    await context.app.ready();
    const routes = [
      ['GET', '/company-api/v1/knowledge/categories'],
      ['GET', '/company-api/v1/knowledge/documents'],
      ['POST', '/company-api/v1/knowledge/uploads'],
      ['GET', '/company-api/v1/knowledge/uploads/:upload_id'],
      ['POST', '/company-api/v1/knowledge/documents/:document_id/archive'],
      ['POST', '/company-api/v1/knowledge/documents/:document_id/restore'],
      ['POST', '/company-api/v1/knowledge/documents/:document_id/reindex'],
      ['GET', '/company-api/v1/requirements'],
      ['POST', '/company-api/v1/requirements'],
      ['GET', '/company-api/v1/requirements/:requirement_id'],
      ['PATCH', '/company-api/v1/requirements/:requirement_id'],
      ['POST', '/company-api/v1/requirements/:requirement_id/split-runs'],
      ['POST', '/company-api/v1/requirements/:requirement_id/apply-split'],
      ['POST', '/company-api/v1/requirements/:requirement_id/publish'],
      ['POST', '/company-api/v1/requirements/:requirement_id/cancel'],
      ['GET', '/company-api/v1/tasks'],
      ['GET', '/company-api/v1/tasks/:task_id'],
      ['POST', '/company-api/v1/tasks/:task_id/transitions'],
      ['POST', '/company-api/v1/tasks/:task_id/submissions'],
      ['POST', '/company-api/v1/tasks/:task_id/review-runs'],
      ['POST', '/company-api/v1/tasks/:task_id/accept'],
      ['POST', '/company-api/v1/tasks/:task_id/return'],
      ['GET', '/company-api/v1/automation-operations/:operation_id'],
      ['GET', '/company-api/v1/daily-reports'],
      ['GET', '/company-api/v1/daily-reports/:work_date'],
      ['PUT', '/company-api/v1/daily-reports/:work_date'],
      ['DELETE', '/company-api/v1/daily-reports/:work_date'],
      ['POST', '/company-api/v1/daily-reports/:work_date/publish'],
      ['POST', '/company-api/v1/daily-reports/:work_date/rewrite-runs'],
      ['POST', '/company-api/v1/daily-reports/:work_date/apply-rewrite'],
      ['GET', '/company-api/v1/departments/:department_id/daily-reports'],
    ] as const;
    for (const [method, url] of routes) {
      expect(context.app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
  });

  it('requires a valid actor token whose request id matches the header', async () => {
    const context = createTestContext();
    contexts.push(context);
    const missing = await context.app.inject({
      method: 'GET',
      url: '/company-api/v1/tasks',
      headers: { 'x-request-id': 'request-0001' },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: 'unauthorized', request_id: 'request-0001' });

    const headers = await authHeaders(actors.devA);
    headers['x-request-id'] = 'request-other';
    const mismatch = await context.app.inject({
      method: 'GET',
      url: '/company-api/v1/tasks',
      headers,
    });
    expect(mismatch.statusCode).toBe(401);
  });

  it('rejects actor tokens whose lifetime exceeds the frozen 60 second maximum', async () => {
    const context = createTestContext();
    contexts.push(context);
    const response = await context.app.inject({
      method: 'GET',
      url: '/company-api/v1/tasks',
      headers: await authHeaders(actors.devA, {}, 61),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().detail).toMatch(/lifetime/);
  });
});
