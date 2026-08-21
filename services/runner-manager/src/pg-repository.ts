import pg from 'pg';

import { StaleRunnerFenceError, type RunnerRecord, type RunnerRepository } from './domain.js';

const { Pool } = pg;

function mapRunner(row: Record<string, unknown>): RunnerRecord {
  const state = row.state as RunnerRecord['state'];
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    userId: row.user_id as string,
    containerId: row.container_id as string | null,
    imageVersion: row.image_version as string,
    state,
    health:
      state === 'ready' || state === 'busy' || state === 'idle'
        ? 'healthy'
        : state === 'starting'
          ? 'starting'
          : state === 'failed'
            ? 'unhealthy'
            : 'unknown',
    internalEndpoint: row.internal_endpoint as string | null,
    configVersion: row.config_version as number,
    activeRuns: 0,
    leaseExpiresAt: null,
    lastActivityAt: row.last_activity_at as Date | null,
    version: row.version as number,
    fencingToken: Number(row.fencing_token),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export class PgRunnerRepository implements RunnerRepository {
  readonly pool: pg.Pool;

  constructor(connectionString: string | pg.Pool) {
    this.pool =
      typeof connectionString === 'string' ? new Pool({ connectionString }) : connectionString;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async get(runnerId: string): Promise<RunnerRecord | null> {
    const result = await this.pool.query('SELECT * FROM platform.runner_instances WHERE id=$1', [
      runnerId,
    ]);
    return result.rows[0] ? mapRunner(result.rows[0]) : null;
  }

  async getActiveByUser(userId: string): Promise<RunnerRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM platform.runner_instances
       WHERE user_id=$1 AND state IN ('starting','ready','busy','idle','stopping')
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? mapRunner(result.rows[0]) : null;
  }

  async list(): Promise<RunnerRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM platform.runner_instances ORDER BY created_at, id',
    );
    return result.rows.map(mapRunner);
  }

  async create(record: RunnerRecord, fencingToken: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await claimFence(client, record.userId, fencingToken);
      await client.query(
        `INSERT INTO platform.runner_instances
         (id,tenant_id,user_id,container_id,image_version,state,internal_endpoint,
          config_version,last_activity_at,version,fencing_token,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          record.id,
          record.tenantId,
          record.userId,
          record.containerId,
          record.imageVersion,
          record.state,
          record.internalEndpoint,
          record.configVersion,
          record.lastActivityAt,
          record.version,
          fencingToken,
          record.createdAt,
          record.updatedAt,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async save(record: RunnerRecord, fencingToken: number): Promise<RunnerRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await claimFence(client, record.userId, fencingToken);
      const result = await client.query(
        `UPDATE platform.runner_instances SET
         container_id=$2,image_version=$3,state=$4,internal_endpoint=$5,config_version=$6,
         last_activity_at=$7,fencing_token=$8,version=version+1,updated_at=now()
         WHERE id=$1 AND fencing_token <= $8 RETURNING *`,
        [
          record.id,
          record.containerId,
          record.imageVersion,
          record.state,
          record.internalEndpoint,
          record.configVersion,
          record.lastActivityAt,
          fencingToken,
        ],
      );
      if (!result.rows[0]) throw new StaleRunnerFenceError('Runner state write was fenced out');
      await client.query('COMMIT');
      const saved = mapRunner(result.rows[0]);
      saved.health = record.health;
      saved.activeRuns = record.activeRuns;
      saved.leaseExpiresAt = record.leaseExpiresAt;
      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function claimFence(client: pg.PoolClient, userId: string, fencingToken: number) {
  const result = await client.query(
    `INSERT INTO platform.runner_fences(user_id, fencing_token)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       fencing_token=excluded.fencing_token, updated_at=now()
     WHERE platform.runner_fences.fencing_token <= excluded.fencing_token
     RETURNING fencing_token`,
    [userId, fencingToken],
  );
  if (result.rowCount === 0)
    throw new StaleRunnerFenceError('Runner lifecycle holder was fenced out');
}
