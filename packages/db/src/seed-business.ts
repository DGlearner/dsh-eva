import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg, { type PoolClient } from 'pg';

const { Pool } = pg;

type JsonRecord = Record<string, unknown>;

export interface BusinessFixture {
  tenant: { id: string };
  users: Array<{ id: string }>;
  departments: Array<{ id: string }>;
  department_members: Array<{
    department_id: string;
    user_id: string;
    org_role: 'manager' | 'member';
  }>;
  knowledge: {
    documents: Array<{
      id: string;
      fixture_key: string;
      knowledge_id: string;
      owner_user_id: string | null;
      scope: string;
      category: string | null;
      title: string;
      file_name: string;
      media_type: string;
      size_bytes: number;
      status: string;
      version: number;
      updated_at: string;
    }>;
    chunks: Array<JsonRecord & { document_id: string }>;
    uploads: Array<{
      id: string;
      document_id: string;
      owner_user_id: string;
      status: string;
      progress: number;
      error_code: string | null;
      created_at: string;
      updated_at: string;
    }>;
  };
  requirements: Array<{
    id: string;
    department_id: string;
    publisher_user_id: string;
    title: string;
    objective: string;
    acceptance_criteria: string[];
    status: string;
    version: number;
    created_at: string;
    updated_at: string;
    published_at: string | null;
  }>;
  tasks: Array<{
    id: string;
    requirement_id: string;
    parent_task_id: string | null;
    department_id: string;
    assignee_user_id: string | null;
    title: string;
    description: string;
    acceptance_criteria: string[];
    status: string;
    position: number;
    due_at: string | null;
    latest_review_result: string | null;
    version: number;
    updated_at: string;
  }>;
  task_dependencies: Array<{ task_id: string; depends_on_task_id: string }>;
  task_submissions: Array<{
    id: string;
    task_id: string;
    submitter_user_id: string;
    summary: string;
    evidence: unknown[];
    created_at: string;
  }>;
  automation_operations: Array<{
    id: string;
    kind: string;
    actor_user_id: string;
    resource_type: string;
    resource_id: string;
    provider: string;
    status: string;
    result: JsonRecord | null;
    error: JsonRecord | null;
    created_at: string;
    completed_at: string | null;
  }>;
  task_review_runs: Array<{
    id: string;
    task_id: string;
    submission_id: string;
    automation_run_id: string;
    status: string;
    result: string | null;
    summary: string | null;
    checks: unknown[];
    evidence: unknown[];
    executor_version: string;
    created_at: string;
    completed_at: string | null;
  }>;
  daily_reports: Array<{
    id: string;
    user_id: string;
    department_id: string;
    work_date: string;
    content: JsonRecord;
    status: string;
    version: number;
    published_at: string | null;
    updated_at: string;
  }>;
  daily_report_revisions: Array<{
    id: string;
    report_id: string;
    editor_user_id: string;
    source: string;
    before_content: JsonRecord | null;
    after_content: JsonRecord;
    created_at: string;
  }>;
}

export interface BusinessSeedResult {
  inserted: number;
  expected: number;
}

export async function seedBusinessFixtures(
  connectionString: string,
  fixture: BusinessFixture,
  nodeEnv: string,
): Promise<BusinessSeedResult> {
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error('Business fixture seed is restricted to development and test environments.');
  }
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await validatePlatformFixture(client, fixture);
    const result = await seed(client, fixture);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function seed(client: PoolClient, fixture: BusinessFixture): Promise<BusinessSeedResult> {
  let inserted = 0;
  let expected = 0;
  const add = async (sql: string, values: unknown[]) => {
    expected += 1;
    const result = await client.query(sql, values);
    inserted += result.rowCount ?? 0;
  };

  for (const document of fixture.knowledge.documents) {
    const chunks = fixture.knowledge.chunks
      .filter((chunk) => chunk.document_id === document.id)
      .map(({ document_id: _documentId, ...chunk }) => chunk);
    await add(
      `INSERT INTO business.fake_knowledge_documents
       (id, tenant_id, fixture_key, knowledge_id, owner_user_id, scope, category, title,
        file_name, media_type, size_bytes, status, content_chunks, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$15)
       ON CONFLICT (id) DO NOTHING`,
      [
        document.id,
        fixture.tenant.id,
        document.fixture_key,
        document.knowledge_id,
        document.owner_user_id,
        document.scope,
        document.category,
        document.title,
        document.file_name,
        document.media_type,
        document.size_bytes,
        document.status,
        JSON.stringify(chunks),
        document.version,
        document.updated_at,
      ],
    );
  }
  for (const upload of fixture.knowledge.uploads) {
    await add(
      `INSERT INTO business.fake_knowledge_uploads
       (id, tenant_id, document_id, owner_user_id, status, progress, error_code, scenario,
        poll_count, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,3,1,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        upload.id,
        fixture.tenant.id,
        upload.document_id,
        upload.owner_user_id,
        upload.status,
        upload.progress,
        upload.error_code,
        upload.status === 'failed' ? 'fail' : 'success',
        upload.created_at,
        upload.updated_at,
      ],
    );
  }
  for (const requirement of fixture.requirements) {
    await add(
      `INSERT INTO business.requirements
       (id, tenant_id, department_id, publisher_user_id, title, objective, acceptance_criteria,
        status, published_at, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        requirement.id,
        fixture.tenant.id,
        requirement.department_id,
        requirement.publisher_user_id,
        requirement.title,
        requirement.objective,
        JSON.stringify(requirement.acceptance_criteria),
        requirement.status,
        requirement.published_at,
        requirement.version,
        requirement.created_at,
        requirement.updated_at,
      ],
    );
  }
  for (const task of fixture.tasks) {
    await add(
      `INSERT INTO business.tasks
       (id, requirement_id, parent_task_id, department_id, assignee_user_id, title, description,
        acceptance_criteria, status, position, due_at, latest_review_result, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        task.id,
        task.requirement_id,
        task.parent_task_id,
        task.department_id,
        task.assignee_user_id,
        task.title,
        task.description,
        JSON.stringify(task.acceptance_criteria),
        task.status,
        task.position,
        task.due_at,
        task.latest_review_result,
        task.version,
        task.updated_at,
      ],
    );
  }
  for (const dependency of fixture.task_dependencies) {
    await add(
      `INSERT INTO business.task_dependencies(task_id, depends_on_task_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [dependency.task_id, dependency.depends_on_task_id],
    );
  }
  for (const submission of fixture.task_submissions) {
    await add(
      `INSERT INTO business.task_submissions
       (id, task_id, submitter_user_id, summary, evidence, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING`,
      [
        submission.id,
        submission.task_id,
        submission.submitter_user_id,
        submission.summary,
        JSON.stringify(submission.evidence),
        submission.created_at,
      ],
    );
  }
  for (const operation of fixture.automation_operations) {
    await add(
      `INSERT INTO business.automation_operations
       (id, tenant_id, kind, actor_user_id, resource_type, resource_id, provider, provider_run_id,
        status, result, error, version, created_at, updated_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$1,$8,$9::jsonb,$10::jsonb,1,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        operation.id,
        fixture.tenant.id,
        operation.kind,
        operation.actor_user_id,
        operation.resource_type,
        operation.resource_id,
        operation.provider,
        operation.status,
        nullableJson(operation.result),
        nullableJson(operation.error),
        operation.created_at,
        operation.completed_at ?? operation.created_at,
        operation.completed_at,
      ],
    );
  }
  for (const review of fixture.task_review_runs) {
    await add(
      `INSERT INTO business.task_review_runs
       (id, task_id, submission_id, automation_run_id, status, result, summary, checks, evidence,
        executor_version, version, created_at, updated_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,1,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        review.id,
        review.task_id,
        review.submission_id,
        review.automation_run_id,
        review.status,
        review.result,
        review.summary,
        JSON.stringify(review.checks),
        JSON.stringify(review.evidence),
        review.executor_version,
        review.created_at,
        review.completed_at ?? review.created_at,
        review.completed_at,
      ],
    );
  }
  for (const report of fixture.daily_reports) {
    await add(
      `INSERT INTO business.daily_reports
       (id, tenant_id, user_id, department_id, work_date, content, status, published_at,
        deleted_at, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,NULL,$9,$10,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        report.id,
        fixture.tenant.id,
        report.user_id,
        report.department_id,
        report.work_date,
        JSON.stringify(report.content),
        report.status,
        report.published_at,
        report.version,
        report.updated_at,
      ],
    );
  }
  for (const revision of fixture.daily_report_revisions) {
    await add(
      `INSERT INTO business.daily_report_revisions
       (id, report_id, editor_user_id, source, before_content, after_content, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT (id) DO NOTHING`,
      [
        revision.id,
        revision.report_id,
        revision.editor_user_id,
        revision.source,
        nullableJson(revision.before_content),
        JSON.stringify(revision.after_content),
        revision.created_at,
      ],
    );
  }
  return { inserted, expected };
}

async function validatePlatformFixture(
  client: PoolClient,
  fixture: BusinessFixture,
): Promise<void> {
  const tenant = await client.query<{ id: string }>(
    'SELECT id FROM platform.tenants WHERE id = $1',
    [fixture.tenant.id],
  );
  if (tenant.rowCount !== 1)
    throw new Error('Business fixture tenant is missing from Platform seed.');

  const users = await client.query<{ id: string }>(
    'SELECT id FROM platform.users WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [fixture.tenant.id, fixture.users.map(({ id }) => id)],
  );
  if (users.rowCount !== fixture.users.length) {
    throw new Error('Business fixture users do not match Platform seed.');
  }
  const departments = await client.query<{ id: string }>(
    'SELECT id FROM platform.departments WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [fixture.tenant.id, fixture.departments.map(({ id }) => id)],
  );
  if (departments.rowCount !== fixture.departments.length) {
    throw new Error('Business fixture departments do not match Platform seed.');
  }
  const memberships = await client.query<{
    department_id: string;
    user_id: string;
    org_role: string;
  }>(
    `SELECT department_id, user_id, org_role FROM platform.department_members
     WHERE user_id = ANY($1::uuid[])`,
    [fixture.department_members.map(({ user_id }) => user_id)],
  );
  const actual = new Set(
    memberships.rows.map((row) => `${row.department_id}:${row.user_id}:${row.org_role}`),
  );
  if (
    fixture.department_members.some(
      (member) => !actual.has(`${member.department_id}:${member.user_id}:${member.org_role}`),
    )
  ) {
    throw new Error('Business fixture memberships do not match Platform seed.');
  }
}

function nullableJson(value: JsonRecord | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  const nodeEnv = process.env.NODE_ENV;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!nodeEnv) throw new Error('NODE_ENV is required for Business fixture seed');
  if (process.env.BUSINESS_ENABLE_FIXTURE_SEED !== 'true') {
    throw new Error('BUSINESS_ENABLE_FIXTURE_SEED=true is required');
  }
  const fixtureUrl = process.env.TEST_FIXTURE_PATH
    ? pathToFileURL(process.env.TEST_FIXTURE_PATH)
    : new URL(import.meta.resolve('@company/test-fixtures/fixture-v1'));
  const fixture = JSON.parse(await readFile(fileURLToPath(fixtureUrl), 'utf8')) as BusinessFixture;
  const result = await seedBusinessFixtures(databaseUrl, fixture, nodeEnv);
  process.stdout.write(`Seeded ${result.inserted}/${result.expected} Business fixture rows\n`);
}
