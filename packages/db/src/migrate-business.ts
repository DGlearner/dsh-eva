import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg, { type PoolClient } from 'pg';

const { Pool } = pg;
const migrationLock = 'company-dsh:business-migrations';

export interface BusinessMigrationOptions {
  includeDevelopment?: boolean;
  nodeEnv?: string;
  migrationDirectory?: string;
}

export interface BusinessMigrationFile {
  name: string;
  path: string;
  checksum: string;
  track: 'production' | 'development';
}

export async function discoverBusinessMigrations(
  options: BusinessMigrationOptions = {},
): Promise<BusinessMigrationFile[]> {
  const includeDevelopment = options.includeDevelopment ?? false;
  const nodeEnv = options.nodeEnv ?? 'development';
  if (includeDevelopment && nodeEnv === 'production') {
    throw new Error('Development Business migrations are disabled in production.');
  }
  const root =
    options.migrationDirectory ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/business');
  const production = await readMigrationTrack(root, '', 'production');
  const development = includeDevelopment
    ? await readMigrationTrack(resolve(root, 'dev'), 'dev/', 'development')
    : [];
  return [...production, ...development];
}

export async function migrateBusiness(
  connectionString: string,
  options: BusinessMigrationOptions = {},
): Promise<string[]> {
  const migrations = await discoverBusinessMigrations(options);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [migrationLock]);
    locked = true;
    await assertPlatformReady(client);
    await client.query('CREATE SCHEMA IF NOT EXISTS business');
    await client.query(`
      CREATE TABLE IF NOT EXISTS business.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const history = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM business.schema_migrations ORDER BY applied_at, name',
    );
    assertMigrationHistory(migrations, history.rows);

    const appliedNames = new Set(history.rows.map((row) => row.name));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) continue;
      const sql = await readFile(migration.path, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO business.schema_migrations(name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [migrationLock]);
    }
    client.release();
    await pool.end();
  }
}

export function assertMigrationHistory(
  migrations: BusinessMigrationFile[],
  history: Array<{ name: string; checksum: string }>,
): void {
  const available = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const applied of history) {
    const migration = available.get(applied.name);
    if (migration === undefined) {
      throw new Error(`Applied Business migration is missing from this build: ${applied.name}`);
    }
    if (migration.checksum !== applied.checksum) {
      throw new Error(`Applied Business migration was modified: ${applied.name}`);
    }
  }
  for (const track of ['production', 'development'] as const) {
    const expected = migrations
      .filter((migration) => migration.track === track)
      .map(({ name }) => name);
    const actual = history
      .map(({ name }) => available.get(name))
      .filter((migration): migration is BusinessMigrationFile => migration?.track === track)
      .map(({ name }) => name);
    if (actual.some((name, index) => name !== expected[index])) {
      throw new Error(`Business ${track} migrations were applied out of order.`);
    }
  }
}

async function readMigrationTrack(
  directory: string,
  prefix: string,
  track: BusinessMigrationFile['track'],
): Promise<BusinessMigrationFile[]> {
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const path = resolve(directory, file);
      const sql = await readFile(path);
      return {
        name: `${prefix}${file}`,
        path,
        checksum: createHash('sha256').update(sql).digest('hex'),
        track,
      };
    }),
  );
}

async function assertPlatformReady(client: PoolClient): Promise<void> {
  const result = await client.query<{ tenants: string | null }>(
    "SELECT to_regclass('platform.tenants')::text AS tenants",
  );
  if (result.rows[0]?.tenants !== 'platform.tenants') {
    throw new Error('Platform migrations must be applied before Business migrations.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const includeDevelopment = booleanEnv('BUSINESS_INCLUDE_DEV_MIGRATIONS', false);
  const applied = await migrateBusiness(databaseUrl, {
    includeDevelopment,
    nodeEnv: process.env.NODE_ENV ?? 'development',
  });
  process.stdout.write(`Applied ${applied.length} Business migration(s): ${applied.join(', ')}\n`);
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}
