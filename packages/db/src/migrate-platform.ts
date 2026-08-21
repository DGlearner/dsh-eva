import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Pool } = pg;

export async function migratePlatform(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const migrationDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../migrations/platform',
  );
  const applied: string[] = [];

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS platform');
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const exists = await client.query<{ name: string }>(
        'SELECT name FROM platform.schema_migrations WHERE name = $1',
        [file],
      );
      if (exists.rowCount !== 0) continue;

      const sql = await readFile(resolve(migrationDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO platform.schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const applied = await migratePlatform(databaseUrl);
  process.stdout.write(`Applied ${applied.length} platform migration(s): ${applied.join(', ')}\n`);
}
