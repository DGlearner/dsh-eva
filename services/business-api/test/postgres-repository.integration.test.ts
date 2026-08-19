import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBusinessRepository } from '../src/adapters/postgres/postgres-business-repository.js';
import { executeIdempotent } from '../src/application/shared.js';
import type {
  AuditEvent,
  DailyReport,
  Requirement,
  Task,
  TaskStatusHistory,
  TaskSubmission,
} from '../src/domain/models.js';
import { FixedClock } from '../src/ports/clock.js';
import { actors, DEV_A, DEV_DEPARTMENT, DEV_MANAGER, TENANT } from './helpers.js';

const databaseUrl = process.env.BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('PostgreSQL business repository', () => {
  let pool: Pool;
  let repository: PostgresBusinessRepository;
  let ownsSchemas = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const client = await pool.connect();
    try {
      const database = await client.query<{ current_database: string }>(
        'select current_database()',
      );
      if (!/test/i.test(database.rows[0]!.current_database)) {
        throw new Error(
          'BUSINESS_TEST_DATABASE_URL must point to a database whose name contains test.',
        );
      }
      const schemas = await client.query<{ platform: string | null; business: string | null }>(
        `select to_regnamespace('platform')::text as platform,
                to_regnamespace('business')::text as business`,
      );
      if (schemas.rows[0]?.platform !== null || schemas.rows[0]?.business !== null) {
        throw new Error('PostgreSQL integration tests require an empty test database.');
      }
      await client.query('begin');
      await client.query('create schema platform');
      await client.query(`
      create table platform.tenants (
        id uuid primary key,
        name text not null,
        created_at timestamptz not null default now()
      );
      create table platform.users (
        id uuid primary key,
        tenant_id uuid not null references platform.tenants(id),
        username text not null,
        display_name text not null,
        platform_role text not null,
        status text not null,
        created_at timestamptz not null default now()
      );
      create table platform.departments (
        id uuid primary key,
        tenant_id uuid not null references platform.tenants(id),
        name text not null,
        status text not null,
        version integer not null,
        created_at timestamptz not null default now()
      );
      create table platform.department_members (
        department_id uuid not null references platform.departments(id),
        user_id uuid not null references platform.users(id),
        org_role text not null,
        primary key (department_id, user_id)
      );
    `);
      for (const migration of [
        '0001_business_v1.sql',
        '0002_business_guards.sql',
        'dev/0001_business_fake_v1.sql',
        'dev/0002_fake_state_guards.sql',
      ]) {
        const sql = await readFile(
          new URL(`../../../packages/db/migrations/business/${migration}`, import.meta.url),
          'utf8',
        );
        await client.query(sql);
      }
      await client.query(`insert into platform.tenants (id, name) values ($1, 'test tenant')`, [
        TENANT,
      ]);
      await client.query(
        `insert into platform.departments (id, tenant_id, name, status, version)
       values ($1, $2, 'engineering', 'active', 1)`,
        [DEV_DEPARTMENT, TENANT],
      );
      await client.query(
        `insert into platform.users
        (id, tenant_id, username, display_name, platform_role, status)
       values
        ($1, $3, 'manager', 'Manager', 'member', 'active'),
        ($2, $3, 'dev-a', 'Dev A', 'member', 'active')`,
        [DEV_MANAGER, DEV_A, TENANT],
      );
      await client.query(
        `insert into platform.department_members (department_id, user_id, org_role)
       values ($1, $2, 'manager'), ($1, $3, 'member')`,
        [DEV_DEPARTMENT, DEV_MANAGER, DEV_A],
      );
      await client.query('commit');
      ownsSchemas = true;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
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
      work_date: '2026-08-18',
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
    expect(await repository.getDailyReport(TENANT, DEV_A, report.work_date)).toEqual(report);
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
