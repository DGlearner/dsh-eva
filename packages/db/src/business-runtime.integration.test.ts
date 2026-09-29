import fixtureJson from '@company/test-fixtures/fixture-v1' with { type: 'json' };
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapPlatform, type PlatformBootstrapResult } from './bootstrap-platform.js';
import { migrateBusiness } from './migrate-business.js';
import { seedBusinessFixtures, type BusinessFixture } from './seed-business.js';
import { migratePlatform } from './migrate-platform.js';
import { seedPlatform } from './seed-platform.js';

const databaseUrl = process.env.BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const fixture = fixtureJson as unknown as BusinessFixture;

describePostgres('Business migration and fixture runtime', () => {
  let pool: Pool;
  let ownsSchemas = false;
  let firstApplied: string[] = [];
  let firstSeed = { inserted: 0, expected: 0 };
  let bootstrap: PlatformBootstrapResult;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const database = await pool.query<{ current_database: string }>('select current_database()');
    if (!/test/i.test(database.rows[0]!.current_database)) {
      throw new Error('BUSINESS_TEST_DATABASE_URL database name must contain test.');
    }
    const schemas = await pool.query<{ platform: string | null; business: string | null }>(
      `select to_regnamespace('platform')::text as platform,
              to_regnamespace('business')::text as business`,
    );
    if (schemas.rows[0]?.platform !== null || schemas.rows[0]?.business !== null) {
      throw new Error('Business DB integration tests require an empty test database.');
    }
    ownsSchemas = true;
    await migratePlatform(databaseUrl!);
    bootstrap = await bootstrapPlatform(databaseUrl!, {
      tenantName: 'Bootstrap Test Company',
      username: 'bootstrap-admin',
      displayName: 'Bootstrap Administrator',
      password: 'bootstrap-password',
    });
    await expect(
      bootstrapPlatform(databaseUrl!, {
        tenantName: 'Second Company',
        username: 'second-admin',
        displayName: 'Second Administrator',
        password: 'second-password',
      }),
    ).rejects.toThrow(/only when tenants and users are empty/);
    firstApplied = await migrateBusiness(databaseUrl!, {
      includeDevelopment: true,
      nodeEnv: 'test',
    });
    await seedPlatform(
      databaseUrl!,
      'business-test-password',
      fixtureJson as unknown as Parameters<typeof seedPlatform>[2],
    );
    firstSeed = await seedBusinessFixtures(databaseUrl!, fixture, 'test');
  });

  afterAll(async () => {
    if (pool !== undefined) {
      if (ownsSchemas) {
        await pool.query('drop schema if exists business cascade');
        await pool.query('drop schema if exists platform cascade');
      }
      await pool.end();
    }
  });

  it('applies each immutable migration once and safely repeats', async () => {
    expect(bootstrap).toMatchObject({ username: 'bootstrap-admin' });
    expect(firstApplied).toEqual([
      '0001_business_v1.sql',
      '0002_business_guards.sql',
      '0003_daily_report_scopes.sql',
      '0004_model_automation_provider.sql',
      'dev/0001_business_fake_v1.sql',
      'dev/0002_fake_state_guards.sql',
    ]);
    await expect(
      migrateBusiness(databaseUrl!, { includeDevelopment: true, nodeEnv: 'test' }),
    ).resolves.toEqual([]);
    const history = await pool.query<{ name: string; checksum: string }>(
      'select name, checksum from business.schema_migrations order by name',
    );
    expect(history.rows).toHaveLength(6);
    expect(history.rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);
  });

  it('seeds fixed Business rows aligned with Platform and repeats without duplicates', async () => {
    expect(firstSeed.inserted).toBe(firstSeed.expected);
    expect(firstSeed.expected).toBeGreaterThan(30);
    await expect(seedBusinessFixtures(databaseUrl!, fixture, 'test')).resolves.toEqual({
      inserted: 0,
      expected: firstSeed.expected,
    });
    const counts = await pool.query<{
      requirements: string;
      tasks: string;
      documents: string;
      reports: string;
    }>(`select
      (select count(*) from business.requirements)::text as requirements,
      (select count(*) from business.tasks)::text as tasks,
      (select count(*) from business.fake_knowledge_documents)::text as documents,
      (select count(*) from business.daily_reports)::text as reports`);
    expect(counts.rows[0]).toEqual({
      requirements: String(fixture.requirements.length),
      tasks: String(fixture.tasks.length),
      documents: String(fixture.knowledge.documents.length),
      reports: String(fixture.daily_reports.length),
    });
  });

  it('does not overwrite persisted runtime changes when the fixture seed is replayed', async () => {
    const reportId = fixture.daily_reports[0]!.id;
    await pool.query('update business.daily_reports set version = 99 where id = $1', [reportId]);
    await seedBusinessFixtures(databaseUrl!, fixture, 'test');
    const report = await pool.query<{ version: number }>(
      'select version from business.daily_reports where id = $1',
      [reportId],
    );
    expect(report.rows[0]?.version).toBe(99);
  });
});
