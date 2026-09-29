import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import argon2 from 'argon2';
import pg from 'pg';

const { Pool } = pg;
const bootstrapLock = 'company-dsh:platform-bootstrap';

export interface PlatformBootstrapInput {
  tenantName: string;
  username: string;
  displayName: string;
  password: string;
}

export interface PlatformBootstrapResult {
  tenantId: string;
  adminUserId: string;
  username: string;
}

export async function bootstrapPlatform(
  connectionString: string,
  input: PlatformBootstrapInput,
): Promise<PlatformBootstrapResult> {
  const normalized = validatePlatformBootstrapInput(input);
  const passwordHash = await argon2.hash(normalized.password, { type: argon2.argon2id });
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [bootstrapLock]);
    locked = true;
    await client.query('BEGIN');
    const readiness = await client.query<{
      tenants: string | null;
      credentials: string | null;
      knowledgeConfigs: string | null;
    }>(
      `SELECT to_regclass('platform.tenants')::text AS tenants,
              to_regclass('platform.local_password_credentials')::text AS credentials,
              to_regclass('platform.knowledge_provider_configs')::text AS "knowledgeConfigs"`,
    );
    if (
      readiness.rows[0]?.tenants !== 'platform.tenants' ||
      readiness.rows[0]?.credentials !== 'platform.local_password_credentials' ||
      readiness.rows[0]?.knowledgeConfigs !== 'platform.knowledge_provider_configs'
    ) {
      throw new Error('Platform migrations must be applied before bootstrap.');
    }
    const existing = await client.query<{ tenants: string; users: string }>(
      `SELECT (SELECT count(*) FROM platform.tenants)::text AS tenants,
              (SELECT count(*) FROM platform.users)::text AS users`,
    );
    if (existing.rows[0]?.tenants !== '0' || existing.rows[0]?.users !== '0') {
      throw new Error('Platform bootstrap is allowed only when tenants and users are empty.');
    }

    const tenantId = randomUUID();
    const adminUserId = randomUUID();
    await client.query(`INSERT INTO platform.tenants(id, name, status) VALUES ($1, $2, 'active')`, [
      tenantId,
      normalized.tenantName,
    ]);
    await client.query(
      `INSERT INTO platform.users
        (id, tenant_id, username, display_name, platform_role, status)
       VALUES ($1, $2, $3, $4, 'admin', 'active')`,
      [adminUserId, tenantId, normalized.username, normalized.displayName],
    );
    await client.query(
      `INSERT INTO platform.local_password_credentials
        (user_id, password_hash, must_change)
       VALUES ($1, $2, true)`,
      [adminUserId, passwordHash],
    );
    await client.query(
      `INSERT INTO platform.knowledge_provider_configs
        (tenant_id, provider, remote_mcp_enabled)
       VALUES ($1, 'disabled', false)`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO platform.audit_events
        (tenant_id, actor_user_id, action, resource_type, resource_id, result, request_id, details)
       VALUES ($1, NULL, 'platform.bootstrap', 'user', $2, 'success', $3, $4::jsonb)`,
      [
        tenantId,
        adminUserId,
        `bootstrap:${randomUUID()}`,
        JSON.stringify({ username: normalized.username }),
      ],
    );
    await client.query('COMMIT');
    return { tenantId, adminUserId, username: normalized.username };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [bootstrapLock]);
    }
    client.release();
    await pool.end();
  }
}

export function validatePlatformBootstrapInput(
  input: PlatformBootstrapInput,
): PlatformBootstrapInput {
  return {
    tenantName: bounded(input.tenantName, 'BOOTSTRAP_TENANT_NAME', 1, 100),
    username: bounded(input.username, 'BOOTSTRAP_ADMIN_USERNAME', 1, 100),
    displayName: bounded(input.displayName, 'BOOTSTRAP_ADMIN_DISPLAY_NAME', 1, 100),
    password: bounded(input.password, 'BOOTSTRAP_ADMIN_PASSWORD', 8, 128, false),
  };
}

function bounded(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
  trim = true,
): string {
  const normalized = trim ? value.trim() : value;
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain ${minimum}-${maximum} characters.`);
  }
  return normalized;
}

async function bootstrapPassword(): Promise<string> {
  const path = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  if (path) return (await readFile(path, 'utf8')).replace(/[\r\n]+$/u, '');
  const value = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!value) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD_FILE or BOOTSTRAP_ADMIN_PASSWORD is required.');
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const result = await bootstrapPlatform(databaseUrl, {
    tenantName: required('BOOTSTRAP_TENANT_NAME'),
    username: required('BOOTSTRAP_ADMIN_USERNAME'),
    displayName: required('BOOTSTRAP_ADMIN_DISPLAY_NAME'),
    password: await bootstrapPassword(),
  });
  process.stdout.write(
    `Bootstrapped tenant ${result.tenantId} and administrator ${result.username} (${result.adminUserId}).\n`,
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
