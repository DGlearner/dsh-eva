import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { DailyReportService } from '../application/daily-report-service.js';
import type { DailyReportSelector } from '../application/daily-report-service.js';
import { presentAutomation, presentDailyReport } from './presenters.js';
import { cursorLimit, dailyContent, dateString, parseIdempotencyKey, uuid } from './schemas.js';

const reportStatus = z.enum(['draft', 'published', 'deleted']);
const reportScope = z.enum(['personal', 'department', 'company', 'task']);
const selectorFields = { scope: reportScope.default('department'), task_id: uuid.optional() };

function validateSelectorPair(
  value: { scope?: z.infer<typeof reportScope>; task_id?: string },
  context: z.RefinementCtx,
): void {
  if ((value.scope === 'task') !== (value.task_id !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'task_id is required only for task reports',
    });
  }
}

const selectorSchema = z.object(selectorFields).strict().superRefine(validateSelectorPair);
const listQuerySchema = cursorLimit
  .extend({
    from: dateString.optional(),
    to: dateString.optional(),
    status: reportStatus.optional(),
    scope: reportScope.optional(),
    task_id: uuid.optional(),
  })
  .strict()
  .superRefine(validateSelectorPair);
const deleteQuerySchema = z
  .object({ ...selectorFields, expected_version: z.coerce.number().int().min(1) })
  .strict()
  .superRefine(validateSelectorPair);

function selector(value: unknown): DailyReportSelector {
  const parsed = selectorSchema.parse(value);
  return { scope: parsed.scope, task_id: parsed.task_id ?? null };
}

export function registerDailyReportRoutes(app: FastifyInstance, service: DailyReportService): void {
  app.get('/daily-reports', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const result = await service.list(request.actor, query);
    return { ...result, items: result.items.map(presentDailyReport) };
  });

  app.get('/daily-reports/:work_date', async (request) => {
    const params = z.object({ work_date: dateString }).parse(request.params);
    return presentDailyReport(
      await service.get(request.actor, params.work_date, selector(request.query)),
    );
  });

  app.put('/daily-reports/:work_date', async (request) => {
    const params = z.object({ work_date: dateString }).parse(request.params);
    const body = z
      .object({ content: dailyContent, expected_version: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    return presentDailyReport(
      await service.upsert(
        request.actor,
        params.work_date,
        selector(request.query),
        body.content,
        body.expected_version,
      ),
    );
  });

  app.post('/daily-reports/:work_date/publish', async (request) => {
    const params = z.object({ work_date: dateString }).parse(request.params);
    const body = z
      .object({ expected_version: z.number().int().min(1) })
      .strict()
      .parse(request.body);
    const result = await service.publish(
      request.actor,
      params.work_date,
      selector(request.query),
      body.expected_version,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentDailyReport(result.body);
  });

  app.post('/daily-reports/:work_date/rewrite-runs', async (request, reply) => {
    const params = z.object({ work_date: dateString }).parse(request.params);
    const body = z
      .object({
        mode: z.enum(['polish', 'shorten', 'structure']),
        expected_version: z.number().int().min(1),
      })
      .strict()
      .parse(request.body);
    const result = await service.startRewrite(
      request.actor,
      params.work_date,
      selector(request.query),
      body.mode,
      body.expected_version,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(presentAutomation(result.body));
  });

  app.post('/daily-reports/:work_date/apply-rewrite', async (request) => {
    const params = z.object({ work_date: dateString }).parse(request.params);
    const body = z
      .object({
        operation_id: uuid,
        content: dailyContent,
        expected_version: z.number().int().min(1),
      })
      .strict()
      .parse(request.body);
    const result = await service.applyRewrite(
      request.actor,
      params.work_date,
      selector(request.query),
      body,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return presentDailyReport(result.body);
  });

  app.delete('/daily-reports/:work_date', async (request, reply) => {
    const params = z.object({ work_date: dateString }).parse(request.params);
    const query = deleteQuerySchema.parse(request.query);
    await service.delete(
      request.actor,
      params.work_date,
      { scope: query.scope, task_id: query.task_id ?? null },
      query.expected_version,
    );
    return reply.code(204).send();
  });

  app.get('/departments/:department_id/daily-reports', async (request) => {
    const params = z.object({ department_id: uuid }).parse(request.params);
    const query = cursorLimit
      .extend({
        date: dateString.optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        member_user_id: uuid.optional(),
        status: reportStatus.optional(),
      })
      .strict()
      .parse(request.query);
    const result = await service.departmentView(request.actor, params.department_id, query);
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        report: item.report === null ? null : presentDailyReport(item.report),
      })),
    };
  });
}
