import { afterEach, describe, expect, it } from 'vitest';

import { actors, authHeaders, createTestContext, DEV_A, DEV_DEPARTMENT } from './helpers.js';

const contexts: ReturnType<typeof createTestContext>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ app }) => app.close()));
});

const content = {
  completed_today: '完成日报接口。',
  next_plan: '补充集成测试。',
  blockers: '无。',
  other: '无。',
  free_text: null,
};

describe('Daily Reports API', () => {
  it('keeps one row per user/work date, revisions edits, and reopens soft-deleted rows', async () => {
    const context = createTestContext();
    contexts.push(context);
    const headers = await authHeaders(actors.devA);
    const first = await context.app.inject({
      method: 'PUT',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers,
      payload: { content, expected_version: 0 },
    });
    expect(first.statusCode).toBe(200);

    const duplicateCreate = await context.app.inject({
      method: 'PUT',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers,
      payload: { content, expected_version: 0 },
    });
    expect(duplicateCreate.statusCode).toBe(412);

    const edited = await context.app.inject({
      method: 'PUT',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers,
      payload: {
        content: { ...content, completed_today: '完成日报接口和测试。' },
        expected_version: 1,
      },
    });
    expect(edited.json().id).toBe(first.json().id);

    const deleted = await context.app.inject({
      method: 'DELETE',
      url: '/company-api/v1/daily-reports/2026-08-19?expected_version=2',
      headers,
    });
    expect(deleted.statusCode).toBe(204);

    const reopened = await context.app.inject({
      method: 'PUT',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers,
      payload: { content, expected_version: 3 },
    });
    expect(reopened.json()).toMatchObject({ id: first.json().id, status: 'draft', version: 4 });
    const reports = await context.repository.listDailyReports(actors.devA.tenantId);
    expect(
      reports.filter((report) => report.user_id === DEV_A && report.work_date === '2026-08-19'),
    ).toHaveLength(1);
    expect(await context.repository.listDailyReportRevisions(first.json().id)).toHaveLength(3);
  });

  it('replays publish and does not publish rewrite previews automatically', async () => {
    const context = createTestContext();
    contexts.push(context);
    const report = await context.app.inject({
      method: 'PUT',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers: await authHeaders(actors.devA),
      payload: { content, expected_version: 0 },
    });
    const rewrite = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/daily-reports/2026-08-19/rewrite-runs',
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'rewrite-start-001' }),
      payload: { mode: 'polish', expected_version: report.json().version },
    });
    let completedRewrite: { result: { content: typeof content } } | undefined;
    for (let index = 0; index < 2; index += 1) {
      const polled = await context.app.inject({
        method: 'GET',
        url: `/company-api/v1/automation-operations/${rewrite.json().id}`,
        headers: await authHeaders(actors.devA),
      });
      completedRewrite = polled.json() as { result: { content: typeof content } };
    }
    const unchanged = await context.app.inject({
      method: 'GET',
      url: '/company-api/v1/daily-reports/2026-08-19',
      headers: await authHeaders(actors.devA),
    });
    expect(unchanged.json()).toMatchObject({ status: 'draft', version: 1 });

    const applied = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/daily-reports/2026-08-19/apply-rewrite',
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'rewrite-apply-001' }),
      payload: {
        operation_id: rewrite.json().id,
        content: completedRewrite!.result.content,
        expected_version: 1,
      },
    });
    expect(applied.json()).toMatchObject({ status: 'draft', version: 2 });
    expect(await context.repository.listDailyReportRevisions(report.json().id)).toHaveLength(2);

    const publishHeaders = await authHeaders(actors.devA, {
      'idempotency-key': 'daily-publish-001',
    });
    const first = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/daily-reports/2026-08-19/publish',
      headers: publishHeaders,
      payload: { expected_version: 2 },
    });
    const replay = await context.app.inject({
      method: 'POST',
      url: '/company-api/v1/daily-reports/2026-08-19/publish',
      headers: publishHeaders,
      payload: { expected_version: 2 },
    });
    expect(replay.json()).toEqual(first.json());
    expect(first.json().status).toBe('published');
    const audits = await context.repository.listAuditEvents(actors.devA.tenantId);
    expect(audits.filter((event) => event.action === 'daily_report.published')).toHaveLength(1);
  });

  it('rejects applying an old rewrite after its report was soft-deleted', async () => {
    const context = createTestContext();
    contexts.push(context);
    const workDate = '2026-08-20';
    const report = await context.app.inject({
      method: 'PUT',
      url: `/company-api/v1/daily-reports/${workDate}`,
      headers: await authHeaders(actors.devA),
      payload: { content, expected_version: 0 },
    });
    const rewrite = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/daily-reports/${workDate}/rewrite-runs`,
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'deleted-rewrite-start' }),
      payload: { mode: 'polish', expected_version: 1 },
    });
    let rewritten = content;
    for (let index = 0; index < 2; index += 1) {
      const polled = await context.app.inject({
        method: 'GET',
        url: `/company-api/v1/automation-operations/${rewrite.json().id}`,
        headers: await authHeaders(actors.devA),
      });
      rewritten = polled.json().result?.content ?? rewritten;
    }
    expect(
      (
        await context.app.inject({
          method: 'DELETE',
          url: `/company-api/v1/daily-reports/${workDate}?expected_version=1`,
          headers: await authHeaders(actors.devA),
        })
      ).statusCode,
    ).toBe(204);

    const applied = await context.app.inject({
      method: 'POST',
      url: `/company-api/v1/daily-reports/${workDate}/apply-rewrite`,
      headers: await authHeaders(actors.devA, { 'idempotency-key': 'deleted-rewrite-apply' }),
      payload: {
        operation_id: rewrite.json().id,
        content: rewritten,
        expected_version: 2,
      },
    });

    expect(applied.statusCode).toBe(409);
    expect(applied.json()).toMatchObject({ code: 'daily_report_deleted' });
    expect(
      await context.repository.getDailyReport(actors.devA.tenantId, actors.devA.userId, workDate),
    ).toMatchObject({ id: report.json().id, status: 'deleted', version: 2 });
  });

  it('uses Asia/Shanghai for the default department date and includes missing members', async () => {
    const context = createTestContext('2026-08-18T16:30:00Z');
    contexts.push(context);
    const view = await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/departments/${DEV_DEPARTMENT}/daily-reports`,
      headers: await authHeaders(actors.manager),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ from: '2026-08-19', to: '2026-08-19' });
    expect(view.json().items).toHaveLength(3);
    expect(view.json().items.every((item: { report: unknown }) => item.report === null)).toBe(true);

    const denied = await context.app.inject({
      method: 'GET',
      url: `/company-api/v1/departments/${DEV_DEPARTMENT}/daily-reports?date=2026-08-18`,
      headers: await authHeaders(actors.devA),
    });
    expect(denied.statusCode).toBe(403);
  });
});
