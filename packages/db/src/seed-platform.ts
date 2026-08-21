import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import argon2 from 'argon2';
import pg, { type PoolClient } from 'pg';

const { Pool } = pg;

type FixtureUser = {
  id: string;
  username: string;
  display_name: string;
  platform_role: 'admin' | 'member';
  status: 'active' | 'disabled';
};

type FixtureDepartment = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  version: number;
};
type FixtureMember = {
  department_id: string;
  user_id: string;
  org_role: 'manager' | 'member';
  version: number;
};

type PlatformFixture = {
  tenant: { id: string; name: string; status: 'active' | 'disabled' };
  users: FixtureUser[];
  departments: FixtureDepartment[];
  department_members: FixtureMember[];
};

async function seed(client: PoolClient, fixture: PlatformFixture, password: string): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await client.query(
    `INSERT INTO platform.tenants(id, name, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = now()`,
    [fixture.tenant.id, fixture.tenant.name, fixture.tenant.status],
  );

  for (const user of fixture.users) {
    await client.query(
      `INSERT INTO platform.users(id, tenant_id, username, display_name, platform_role, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         platform_role = excluded.platform_role,
         status = excluded.status,
         updated_at = now()`,
      [
        user.id,
        fixture.tenant.id,
        user.username,
        user.display_name,
        user.platform_role,
        user.status,
      ],
    );
    await client.query(
      `INSERT INTO platform.local_password_credentials(user_id, password_hash, must_change)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id) DO UPDATE SET
         password_hash = excluded.password_hash,
         must_change = false,
         changed_at = now(),
         version = platform.local_password_credentials.version + 1,
         updated_at = now()`,
      [user.id, passwordHash],
    );
  }

  for (const department of fixture.departments) {
    await client.query(
      `INSERT INTO platform.departments(id, tenant_id, name, status, version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         status = excluded.status,
         version = excluded.version,
         updated_at = now()`,
      [department.id, fixture.tenant.id, department.name, department.status, department.version],
    );
  }

  for (const member of fixture.department_members) {
    await client.query('DELETE FROM platform.department_members WHERE user_id = $1', [
      member.user_id,
    ]);
    await client.query(
      `INSERT INTO platform.department_members(department_id, user_id, org_role, version)
       VALUES ($1, $2, $3, $4)`,
      [member.department_id, member.user_id, member.org_role, member.version],
    );
  }

  await client.query(
    `INSERT INTO platform.knowledge_provider_configs(tenant_id, provider, remote_mcp_enabled)
     VALUES ($1, 'fake', false)
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = 'fake', remote_mcp_enabled = false, endpoint = null, auth_secret_id = null`,
    [fixture.tenant.id],
  );
}

export async function seedPlatform(
  connectionString: string,
  password: string,
  fixture: PlatformFixture,
): Promise<void> {
  if (password.length < 8) throw new Error('Test seed password must contain at least 8 characters');

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seed(client, fixture, password);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  const password = process.env.TEST_SEED_PASSWORD;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!password) throw new Error('TEST_SEED_PASSWORD is required and is never read from fixtures');

  const fixtureUrl = process.env.TEST_FIXTURE_PATH
    ? new URL(`file://${process.env.TEST_FIXTURE_PATH}`)
    : new URL(import.meta.resolve('@company/test-fixtures/fixture-v1'));
  const fixture = JSON.parse(await readFile(fileURLToPath(fixtureUrl), 'utf8')) as PlatformFixture;
  await seedPlatform(databaseUrl, password, fixture);
  process.stdout.write(`Seeded ${fixture.users.length} platform users\n`);
}
