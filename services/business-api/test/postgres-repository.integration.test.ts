import { randomUUID } from 'node:crypto';

import {
  migrateBusiness,
  migratePlatform,
  seedBusinessFixtures,
  seedPlatform,
  type BusinessFixture,
} from '@company/db';
import fixtureJson from '@company/test-fixtures/fixture-v1' with { type: 'json' };
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeAutomationProvider } from '../src/adapters/automation/fake-automation-provider.js';
import { PostgresBusinessRepository } from '../src/adapters/postgres/postgres-business-repository.js';
import { buildBusinessApp } from '../src/app.js';
import { executeIdempotent } from '../src/application/shared.js';
import type { BusinessRuntimeConfig } from '../src/config.js';
import type {
  AuditEvent,
  DailyReport,
  Requirement,
  Task,
  TaskStatusHistory,
  TaskSubmission,
} from '../src/domain/models.js';
import { FixedClock } from '../src/ports/clock.js';
import { startBusinessRuntime } from '../src/runtime.js';
import {
  actors,
  authHeaders,
  DEV_A,
  DEV_B,
  DEV_DEPARTMENT,
  DEV_MANAGER,
  ISSUER,
  SECRET,
  TENANT,
} from './helpers.js';

const databaseUrl = process.env.BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const fixture = fixtureJson as unknown as BusinessFixture;

describePostgres('PostgreSQL business repository', () => {
  let pool: Pool;
  let repository: PostgresBusinessRepository;
  let ownsSchemas = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const database = await pool.query<{ current_database: string }>('select current_database()');
    if (!/test/i.test(database.rows[0]!.current_database)) {
      throw new Error(
        'BUSINESS_TEST_DATABASE_URL must point to a database whose name contains test.',
      );
    }
    const schemas = await pool.query<{ platform: string | null; business: string | null }>(
      `select to_regnamespace('platform')::text as platform,
              to_regnamespace('business')::text as business`,
    );
    if (schemas.rows[0]?.platform !== null || schemas.rows[0]?.business !== null) {
      throw new Error('PostgreSQL integration tests require an empty test database.');
    }
    ownsSchemas = true;
    await migratePlatform(databaseUrl!);
    await migrateBusiness(databaseUrl!, { includeDevelopment: true, nodeEnv: 'test' });
    await seedPlatform(
      databaseUrl!,
      'business-test-password',
      fixtureJson as unknown as Parameters<typeof seedPlatform>[2],
    );
    await seedBusinessFixtures(databaseUrl!, fixture, 'test');
    repository = new PostgresBusinessRepository(pool);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      if (ownsSchemas) {
        await pool.query('drop schema business cascade');
        await pool.query('drop schema platform cascade');
      }
      await pool.end();
    }
  });

  it('applies production and fake forward migrations', async () => {
    const result = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'business'
       order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'requirements',
        'tasks',
        'daily_reports',
        'idempotency_records',
        'audit_events',
        'fake_knowledge_documents',
      ]),
    );
  });

  it('starts the PostgreSQL/fake runtime with Actor Token isolation and survives restart', async () => {
    const taskId = '00000000-0000-4000-8000-000000004002';
    const workDate = '2026-08-22';
    const content = {
      completed_today: 'Persisted through a Business API restart.',
      next_plan: 'Verify recovery.',
      blockers: 'None.',
      other: 'None.',
      free_text: null,
    };
    const first = await startBusinessRuntime(postgresRuntimeConfig(), { logger: false });
    try {
      expect((await fetch(`${first.address}/healthz`)).status).toBe(200);
      expect(
        (
          await fetch(`${first.address}/company-api/v1/tasks`, {
            headers: { 'x-request-id': 'request-0001' },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${first.address}/company-api/v1/tasks/${taskId}`, {
            headers: await authHeaders(actors.devA),
          })
        ).status,
      ).toBe(200);
      for (const actor of [actors.devB, actors.productManager]) {
        expect(
          (
            await fetch(`${first.address}/company-api/v1/tasks/${taskId}`, {
              headers: await authHeaders(actor),
            })
          ).status,
        ).toBe(404);
      }
      expect(
        (
          await fetch(
            `${first.address}/company-api/v1/tasks?assignee_user_id=${encodeURIComponent(DEV_B)}`,
            { headers: await authHeaders(actors.devA) },
          )
        ).status,
      ).toBe(403);
      const created = await fetch(`${first.address}/company-api/v1/daily-reports/${workDate}`, {
        method: 'PUT',
        headers: {
          ...(await authHeaders(actors.devA)),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content, expected_version: 0 }),
      });
      expect(created.status).toBe(200);
    } finally {
      await first.close();
    }

    const restarted = await startBusinessRuntime(postgresRuntimeConfig(), { logger: false });
    try {
      const recovered = await fetch(
        `${restarted.address}/company-api/v1/daily-reports/${workDate}`,
        { headers: await authHeaders(actors.devA) },
      );
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ content, version: 1 });
      expect(
        (
          await fetch(`${restarted.address}/company-api/v1/daily-reports/${workDate}`, {
            headers: await authHeaders(actors.devB),
          })
        ).status,
      ).toBe(404);
    } finally {
      await restarted.close();
    }
  });

  it('persists tenant-scoped requirements with atomic optimistic locking', async () => {
    const now = '2026-08-18T10:00:00.000Z';
    const requirement: Requirement = {
      id: randomUUID(),
      tenant_id: TENANT,
      department_id: DEV_DEPARTMENT,
      publisher_user_id: DEV_MANAGER,
      title: 'PostgreSQL integration',
      objective: 'Verify Drizzle repository behavior.',
      acceptance_criteria: ['version guarded'],
      status: 'draft',
      version: 1,
      created_at: now,
      updated_at: now,
      published_at: null,
    };
    await repository.createRequirement(requirement);
    expect(await repository.getRequirement(TENANT, requirement.id)).toEqual(requirement);
    await repository.saveRequirement({ ...requirement, title: 'Updated', version: 2 }, 1);
    await expect(
      repository.saveRequirement({ ...requirement, title: 'Stale', version: 2 }, 1),
    ).rejects.toMatchObject({ status: 412, code: 'version_conflict' });
  });

  it('enforces one report per tenant/user/work date', async () => {
    const now = '2026-08-18T10:00:00.000Z';
    const report: DailyReport = {
      id: randomUUID(),
      tenant_id: TENANT,
      user_id: DEV_A,
      department_id: DEV_DEPARTMENT,
      work_date: '2026-08-21',
      scope: 'department',
      task_id: null,
      content: {
        completed_today: 'done',
        next_plan: 'next',
        blockers: 'none',
        other: 'none',
        free_text: null,
      },
      status: 'draft',
      version: 1,
      published_at: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    await repository.createDailyReport(report);
    await expect(repository.createDailyReport({ ...report, id: randomUUID() })).rejects.toThrow();
    expect(
      await repository.getDailyReport(TENANT, DEV_A, report.work_date, 'department', null),
    ).toEqual(report);
  });

  it('atomically rejects an old rewrite after the report is soft-deleted', async () => {
    const clock = new FixedClock(new Date('2026-08-18T10:00:00.000Z'));
    const app = buildBusinessApp({
      repository,
      automation: new FakeAutomationProvider(clock),
      clock,
      actorTokenSecret: SECRET,
      actorTokenIssuer: ISSUER,
    });
    const workDate = '2026-08-20';
    const content = {
      completed_today: 'PostgreSQL rewrite test.',
      next_plan: 'Keep the deletion final.',
      blockers: 'None.',
      other: 'None.',
      free_text: null,
    };
    try {
      const report = await app.inject({
        method: 'PUT',
        url: `/company-api/v1/daily-reports/${workDate}`,
        headers: await authHeaders(actors.devA),
        payload: { content, expected_version: 0 },
      });
      const rewrite = await app.inject({
        method: 'POST',
        url: `/company-api/v1/daily-reports/${workDate}/rewrite-runs`,
        headers: await authHeaders(actors.devA, { 'idempotency-key': 'postgres-rewrite-start' }),
        payload: { mode: 'polish', expected_version: 1 },
      });
      let rewritten = content;
      for (let index = 0; index < 2; index += 1) {
        const polled = await app.inject({
          method: 'GET',
          url: `/company-api/v1/automation-operations/${rewrite.json().id}`,
          headers: await authHeaders(actors.devA),
        });
        rewritten = polled.json().result?.content ?? rewritten;
      }
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/company-api/v1/daily-reports/${workDate}?expected_version=1`,
            headers: await authHeaders(actors.devA),
          })
        ).statusCode,
      ).toBe(204);
      const revisionsBefore = await repository.listDailyReportRevisions(report.json().id);

      const failed = await app.inject({
        method: 'POST',
        url: `/company-api/v1/daily-reports/${workDate}/apply-rewrite`,
        headers: await authHeaders(actors.devA, { 'idempotency-key': 'postgres-rewrite-apply' }),
        payload: {
          operation_id: rewrite.json().id,
          content: rewritten,
          expected_version: 2,
        },
      });

      expect(failed.statusCode).toBe(409);
      expect(failed.json()).toMatchObject({ code: 'daily_report_deleted' });
      expect(await repository.listDailyReportRevisions(report.json().id)).toEqual(revisionsBefore);
      expect(
        await repository.getIdempotencyRecord(
          TENANT,
          DEV_A,
          `POST /daily-reports/${workDate}/apply-rewrite`,
          'postgres-rewrite-apply',
        ),
      ).toBeNull();
      expect(
        await repository.getDailyReport(TENANT, DEV_A, workDate, 'department', null),
      ).toMatchObject({
        status: 'deleted',
        version: 2,
      });
    } finally {
      await app.close();
    }
  });

  it('replaces an expired idempotency record when its scope is reused', async () => {
    const route = 'POST /requirements';
    const key = 'expired-postgres-key-001';
    await repository.putIdempotencyRecord({
      tenant_id: TENANT,
      actor_user_id: DEV_MANAGER,
      route,
      key,
      request_hash: 'expired-request-hash',
      status_code: 201,
      response_json: { id: 'expired-response' },
      expires_at: '2026-08-18T09:59:59.000Z',
    });

    const result = await executeIdempotent({
      repository,
      clock: new FixedClock(new Date('2026-08-18T10:00:00.000Z')),
      actor: actors.manager,
      route,
      key,
      request: { title: 'new request' },
      statusCode: 201,
      execute: async () => ({ id: 'new-response' }),
    });

    expect(result).toMatchObject({ body: { id: 'new-response' }, replayed: false });
    const stored = await repository.getIdempotencyRecord(TENANT, DEV_MANAGER, route, key);
    expect(stored?.response_json).toEqual({ id: 'new-response' });
    expect(new Date(stored?.expires_at ?? '').toISOString()).toBe('2026-08-19T10:00:00.000Z');
  });

  it('rolls back business data and audit when the final idempotency write fails', async () => {
    const requirement = createRequirementFixture('PostgreSQL rollback');
    const key = 'postgres-idempotency-failure';
    await pool.query(`
      create function business.reject_test_idempotency() returns trigger
      language plpgsql as $$
      begin
        if new.key = '${key}' then
          raise exception 'injected idempotency failure';
        end if;
        return new;
      end
      $$;
      create trigger reject_test_idempotency
      before insert or update on business.idempotency_records
      for each row execute function business.reject_test_idempotency();
    `);
    try {
      await expect(
        executeIdempotent({
          repository,
          clock: new FixedClock(new Date('2026-08-18T10:00:00.000Z')),
          actor: actors.manager,
          route: 'POST /requirements',
          key,
          request: { title: requirement.title },
          statusCode: 201,
          execute: async () => {
            await repository.createRequirement(requirement);
            await repository.addAuditEvent({
              id: randomUUID(),
              tenant_id: TENANT,
              actor_user_id: DEV_MANAGER,
              action: 'requirement.created',
              resource_type: 'requirement',
              resource_id: requirement.id,
              result: 'success',
              request_id: 'postgres-rollback-test',
              details: {},
              created_at: requirement.created_at,
            });
            return requirement;
          },
        }),
      ).rejects.toThrow();
    } finally {
      await pool.query(`
        drop trigger reject_test_idempotency on business.idempotency_records;
        drop function business.reject_test_idempotency();
      `);
    }

    expect(await repository.getRequirement(TENANT, requirement.id)).toBeNull();
    expect(
      (await repository.listAuditEvents(TENANT)).filter(
        (event) => event.resource_id === requirement.id,
      ),
    ).toHaveLength(0);
    expect(
      await repository.getIdempotencyRecord(TENANT, DEV_MANAGER, 'POST /requirements', key),
    ).toBeNull();
  });

  it('rolls back the losing different-key command after concurrent optimistic locking', async () => {
    const requirement = createRequirementFixture('PostgreSQL concurrent submission');
    const task = createTaskFixture(requirement.id);
    await repository.transaction(async () => {
      await repository.createRequirement(requirement);
      await repository.createTasks([task], []);
    });

    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const waitForBoth = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const keys = ['postgres-submission-race-a', 'postgres-submission-race-b'];
    const repositories = [
      new PostgresBusinessRepository(pool),
      new PostgresBusinessRepository(pool),
    ];
    const results = await Promise.allSettled(
      repositories.map((candidate, index) =>
        executeIdempotent({
          repository: candidate,
          clock: new FixedClock(new Date('2026-08-18T10:00:00.000Z')),
          actor: actors.devA,
          route: `POST /tasks/${task.id}/submissions`,
          key: keys[index]!,
          request: { summary: `submission-${index}`, expected_version: 1 },
          statusCode: 201,
          execute: async () => {
            const current = await candidate.getTask(TENANT, task.id);
            if (current === null) throw new Error('Concurrent test task is missing.');
            await waitForBoth();
            const submission: TaskSubmission = {
              id: randomUUID(),
              task_id: task.id,
              submitter_user_id: DEV_A,
              summary: `submission-${index}`,
              evidence: [],
              created_at: '2026-08-18T10:00:00.000Z',
            };
            const history: TaskStatusHistory = {
              id: randomUUID(),
              task_id: task.id,
              from_status: 'in_progress',
              to_status: 'review',
              actor_user_id: DEV_A,
              reason: 'concurrent integration test',
              created_at: '2026-08-18T10:00:00.000Z',
            };
            const audit: AuditEvent = {
              id: randomUUID(),
              tenant_id: TENANT,
              actor_user_id: DEV_A,
              action: 'task.submitted.concurrent_test',
              resource_type: 'task',
              resource_id: task.id,
              result: 'success',
              request_id: `postgres-concurrency-${index}`,
              details: { submission_id: submission.id },
              created_at: '2026-08-18T10:00:00.000Z',
            };
            await candidate.addTaskSubmission(submission);
            await candidate.saveTask(
              {
                ...current,
                status: 'review',
                version: current.version + 1,
                updated_at: '2026-08-18T10:00:00.000Z',
              },
              current.version,
            );
            await candidate.addTaskStatusHistory(history);
            await candidate.addAuditEvent(audit);
            return submission;
          },
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { status: 412, code: 'version_conflict' } });
    expect(await repository.listTaskSubmissions(task.id)).toHaveLength(1);
    expect(await repository.listTaskStatusHistory(task.id)).toHaveLength(1);
    expect(await repository.getTask(TENANT, task.id)).toMatchObject({
      status: 'review',
      version: 2,
    });
    expect(
      (await repository.listAuditEvents(TENANT)).filter(
        (event) => event.action === 'task.submitted.concurrent_test',
      ),
    ).toHaveLength(1);
    const idempotency = await Promise.all(
      keys.map((key) =>
        repository.getIdempotencyRecord(TENANT, DEV_A, `POST /tasks/${task.id}/submissions`, key),
      ),
    );
    expect(idempotency.filter((record) => record !== null)).toHaveLength(1);
  });

  it('serializes the same idempotency scope with PostgreSQL advisory locks', async () => {
    const first = new PostgresBusinessRepository(pool);
    const second = new PostgresBusinessRepository(pool);
    let active = 0;
    let maximumActive = 0;
    const work = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };
    await Promise.all([
      first.withIdempotencyLock('same-scope', work),
      second.withIdempotencyLock('same-scope', work),
    ]);
    expect(maximumActive).toBe(1);
  });
});

function createRequirementFixture(title: string): Requirement {
  const now = '2026-08-18T10:00:00.000Z';
  return {
    id: randomUUID(),
    tenant_id: TENANT,
    department_id: DEV_DEPARTMENT,
    publisher_user_id: DEV_MANAGER,
    title,
    objective: 'Verify PostgreSQL transaction behavior.',
    acceptance_criteria: ['atomic'],
    status: 'published',
    version: 1,
    created_at: now,
    updated_at: now,
    published_at: now,
  };
}

function postgresRuntimeConfig(): BusinessRuntimeConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    repositoryMode: 'postgres',
    databaseUrl: databaseUrl!,
    automationMode: 'fake',
    internalAutomationBaseUrl: null,
    internalAutomationServiceToken: null,
    knowledgeMode: 'fake',
    actorTokenSecret: SECRET,
    actorTokenIssuer: ISSUER,
  };
}

function createTaskFixture(requirementId: string): Task {
  const now = '2026-08-18T10:00:00.000Z';
  return {
    id: randomUUID(),
    requirement_id: requirementId,
    parent_task_id: null,
    department_id: DEV_DEPARTMENT,
    assignee_user_id: DEV_A,
    title: 'Concurrent task',
    description: 'Verify losing transaction rollback.',
    acceptance_criteria: ['one submission'],
    status: 'in_progress',
    position: 1,
    due_at: null,
    latest_review_result: null,
    version: 1,
    created_at: now,
    updated_at: now,
  };
}
