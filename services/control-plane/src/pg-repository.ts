import pg, { type PoolClient, type QueryResultRow } from 'pg';

import type {
  AuditEventRecord,
  DepartmentRecord,
  IdempotencyRecord,
  KnowledgeProviderRecord,
  MembershipRecord,
  ModelConfigRecord,
  ModelConfigStageRecord,
  PlatformRepository,
  RagUserBindingRecord,
  SessionRecord,
  SessionStatus,
  UserRecord,
  UserStatus,
  WebSessionRecord,
  WorkspaceRecord,
} from './domain.js';
import { HttpProblem } from './problems.js';

const { Pool } = pg;

type UserRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  username: string;
  display_name: string;
  platform_role: UserRecord['platformRole'];
  status: UserRecord['status'];
  version: number;
  password_hash: string;
  must_change: boolean;
  created_at: Date;
  updated_at: Date;
};

const USER_SELECT = `
  SELECT u.id, u.tenant_id, u.username, u.display_name, u.platform_role, u.status,
         u.version, u.created_at, u.updated_at, c.password_hash, c.must_change
  FROM platform.users u
  JOIN platform.local_password_credentials c ON c.user_id = u.id
`;

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    displayName: row.display_name,
    platformRole: row.platform_role,
    status: row.status,
    version: row.version,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDepartment(row: QueryResultRow): DepartmentRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    status: row.status as UserStatus,
    version: row.version as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapMembership(row: QueryResultRow): MembershipRecord {
  return {
    departmentId: row.department_id as string,
    userId: row.user_id as string,
    orgRole: row.org_role as MembershipRecord['orgRole'],
    version: row.version as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapSession(row: QueryResultRow): SessionRecord {
  return {
    sessionId: row.session_id as string,
    tenantId: row.tenant_id as string,
    userId: row.user_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string | null,
    status: row.status as SessionRecord['status'],
    lastEventPosition:
      row.last_event_position === null ? null : Number(row.last_event_position as string | number),
    lastEventAt: row.last_event_at as Date | null,
    version: row.version as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapWebSession(row: QueryResultRow): WebSessionRecord {
  return {
    id: row.id as string,
    tokenHash: row.token_hash as string,
    csrfHash: row.csrf_hash as string,
    userId: row.user_id as string,
    idleExpiresAt: row.idle_expires_at as Date,
    absoluteExpiresAt: row.absolute_expires_at as Date,
    revokedAt: row.revoked_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export class PgPlatformRepository implements PlatformRepository {
  readonly pool: pg.Pool;
  private readonly lockPool: pg.Pool;

  constructor(connectionString: string | pg.Pool) {
    if (typeof connectionString === 'string') {
      this.pool = new Pool({ connectionString });
      // Advisory locks can wait while holding a connection. Keep those waits out of the
      // business pool so concurrent /chat requests cannot starve the lock holder's queries.
      this.lockPool = new Pool({ connectionString, max: 4 });
    } else {
      this.pool = connectionString;
      this.lockPool = connectionString;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    if (this.lockPool !== this.pool) await this.lockPool.end();
  }

  async getDefaultTenantId(): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM platform.tenants WHERE status = 'active' ORDER BY created_at LIMIT 1",
    );
    const tenant = result.rows[0];
    if (!tenant) throw new HttpProblem(503, 'tenant_unavailable', 'No active tenant is configured');
    return tenant.id;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `${USER_SELECT} WHERE lower(u.username) = lower($1) ORDER BY u.created_at LIMIT 1`,
      [username],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [userId]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async listUsers(tenantId: string, status?: UserStatus): Promise<UserRecord[]> {
    const result = await this.pool.query<UserRow>(
      `${USER_SELECT} WHERE u.tenant_id = $1 AND ($2::text IS NULL OR u.status = $2)
       ORDER BY lower(u.username), u.id`,
      [tenantId, status ?? null],
    );
    return result.rows.map(mapUser);
  }

  async createUser(user: UserRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO platform.users
           (id, tenant_id, username, display_name, platform_role, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          user.id,
          user.tenantId,
          user.username,
          user.displayName,
          user.platformRole,
          user.status,
          user.version,
          user.createdAt,
          user.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO platform.local_password_credentials
           (user_id, password_hash, must_change, changed_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [user.id, user.passwordHash, user.mustChangePassword, user.createdAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        throw new HttpProblem(409, 'username_conflict', 'Username is already in use');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateUser(
    userId: string,
    expectedVersion: number,
    patch: Partial<Pick<UserRecord, 'displayName' | 'platformRole' | 'status'>>,
  ): Promise<UserRecord> {
    const result = await this.pool.query(
      `UPDATE platform.users SET
         display_name = COALESCE($3, display_name),
         platform_role = COALESCE($4, platform_role),
         status = COALESCE($5, status),
         version = version + 1,
         updated_at = now()
       WHERE id = $1 AND version = $2
       RETURNING id`,
      [
        userId,
        expectedVersion,
        patch.displayName ?? null,
        patch.platformRole ?? null,
        patch.status ?? null,
      ],
    );
    if (result.rowCount === 0) {
      if (await this.getUser(userId))
        throw new HttpProblem(412, 'version_conflict', 'User version does not match');
      throw new HttpProblem(404, 'user_not_found', 'User was not found');
    }
    return (await this.getUser(userId))!;
  }

  async replacePassword(userId: string, passwordHash: string, mustChange: boolean): Promise<void> {
    const result = await this.pool.query(
      `UPDATE platform.local_password_credentials SET
         password_hash = $2, must_change = $3, changed_at = now(),
         version = version + 1, updated_at = now()
       WHERE user_id = $1`,
      [userId, passwordHash, mustChange],
    );
    if (result.rowCount === 0) throw new HttpProblem(404, 'user_not_found', 'User was not found');
  }

  async createWebSession(session: WebSessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform.web_sessions
        (id, token_hash, csrf_hash, user_id, idle_expires_at, absolute_expires_at,
         revoked_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        session.id,
        session.tokenHash,
        session.csrfHash,
        session.userId,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
        session.revokedAt,
        session.createdAt,
        session.updatedAt,
      ],
    );
  }

  async getWebSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM platform.web_sessions WHERE token_hash = $1',
      [tokenHash],
    );
    return result.rows[0] ? mapWebSession(result.rows[0]) : null;
  }

  async touchWebSession(sessionId: string, idleExpiresAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE platform.web_sessions SET idle_expires_at = LEAST($2, absolute_expires_at),
       version = version + 1, updated_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, idleExpiresAt],
    );
  }

  async revokeWebSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE platform.web_sessions SET revoked_at = COALESCE(revoked_at, now()),
       version = version + 1, updated_at = now() WHERE id = $1`,
      [sessionId],
    );
  }

  async revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
    await this.pool.query(
      `UPDATE platform.web_sessions SET revoked_at = now(), version = version + 1, updated_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, exceptSessionId ?? null],
    );
  }

  async getMembership(userId: string): Promise<MembershipRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM platform.department_members WHERE user_id = $1',
      [userId],
    );
    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  async putMembership(
    membership: MembershipRecord,
    expectedVersion: number,
  ): Promise<MembershipRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        'SELECT * FROM platform.department_members WHERE user_id = $1 FOR UPDATE',
        [membership.userId],
      );
      const current = currentResult.rows[0] ? mapMembership(currentResult.rows[0]) : null;
      if ((!current && expectedVersion !== 0) || (current && current.version !== expectedVersion)) {
        throw new HttpProblem(412, 'version_conflict', 'Membership version does not match');
      }
      if (current)
        await client.query('DELETE FROM platform.department_members WHERE user_id = $1', [
          membership.userId,
        ]);
      const result = await client.query(
        `INSERT INTO platform.department_members
          (department_id, user_id, org_role, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,now()) RETURNING *`,
        [
          membership.departmentId,
          membership.userId,
          membership.orgRole,
          (current?.version ?? 0) + 1,
          current?.createdAt ?? membership.createdAt,
        ],
      );
      await client.query('COMMIT');
      return mapMembership(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDepartments(tenantId: string): Promise<DepartmentRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM platform.departments WHERE tenant_id = $1 ORDER BY lower(name), id',
      [tenantId],
    );
    return result.rows.map(mapDepartment);
  }

  async getDepartment(departmentId: string): Promise<DepartmentRecord | null> {
    const result = await this.pool.query('SELECT * FROM platform.departments WHERE id = $1', [
      departmentId,
    ]);
    return result.rows[0] ? mapDepartment(result.rows[0]) : null;
  }

  async createDepartment(department: DepartmentRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO platform.departments
          (id, tenant_id, name, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          department.id,
          department.tenantId,
          department.name,
          department.status,
          department.version,
          department.createdAt,
          department.updatedAt,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpProblem(409, 'department_name_conflict', 'Department name is already in use');
      }
      throw error;
    }
  }

  async getModelConfig(userId: string): Promise<ModelConfigRecord | null> {
    const result = await this.pool.query(
      `SELECT m.*, s.ciphertext, s.hint
       FROM platform.model_configs m
       LEFT JOIN platform.secrets s ON s.id = m.api_key_secret_id AND s.revoked_at IS NULL
       WHERE m.user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      baseUrl: row.base_url,
      model: row.model,
      models: row.models,
      temperature: Number(row.temperature),
      maxOutputTokens: row.max_output_tokens,
      apiKeyCiphertext: row.ciphertext ? (row.ciphertext as Buffer).toString('utf8') : null,
      apiKeyHint: row.hint,
      configVersion: row.config_version,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getKnowledgeProviderConfig(tenantId: string): Promise<KnowledgeProviderRecord | null> {
    const result = await this.pool.query(
      `SELECT tenant_id, provider, remote_mcp_enabled, endpoint, allowed_tools,
              config_version, version
       FROM platform.knowledge_provider_configs
       WHERE tenant_id=$1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id as string,
      provider: row.provider as KnowledgeProviderRecord['provider'],
      remoteMcpEnabled: row.remote_mcp_enabled as boolean,
      endpoint: row.endpoint as string | null,
      allowedTools: row.allowed_tools as string[],
      configVersion: row.config_version as number,
      version: row.version as number,
    };
  }

  async getRagUserBinding(userId: string): Promise<RagUserBindingRecord | null> {
    const result = await this.pool.query(
      `SELECT b.user_id, b.rag_employee_id, b.status, b.version, s.ciphertext, s.hint
       FROM platform.rag_user_bindings b
       LEFT JOIN platform.secrets s ON s.id=b.token_secret_id AND s.revoked_at IS NULL
       WHERE b.user_id=$1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id as string,
      ragEmployeeId: row.rag_employee_id as string,
      tokenCiphertext: row.ciphertext
        ? (row.ciphertext as Buffer).toString('utf8')
        : null,
      tokenHint: row.hint as string | null,
      status: row.status as RagUserBindingRecord['status'],
      version: row.version as number,
    };
  }

  async putModelConfig(
    config: ModelConfigRecord,
    expectedVersion: number,
  ): Promise<ModelConfigRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        'SELECT * FROM platform.model_configs WHERE user_id = $1 FOR UPDATE',
        [config.userId],
      );
      const current = currentResult.rows[0];
      if ((!current && expectedVersion !== 0) || (current && current.version !== expectedVersion)) {
        throw new HttpProblem(
          412,
          'version_conflict',
          'Model configuration version does not match',
        );
      }

      let secretId: string | null = current?.api_key_secret_id ?? null;
      if (config.apiKeyCiphertext) {
        secretId = await this.putSecret(
          client,
          config.userId,
          config.apiKeyCiphertext,
          config.apiKeyHint,
        );
      }
      if (current) {
        await client.query(
          `UPDATE platform.model_configs SET
             base_url=$2, model=$3, models=$4, temperature=$5, max_output_tokens=$6,
             api_key_secret_id=$7, config_version=config_version+1, version=version+1, updated_at=now()
           WHERE user_id=$1`,
          [
            config.userId,
            config.baseUrl,
            config.model,
            config.models,
            config.temperature,
            config.maxOutputTokens,
            secretId,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO platform.model_configs
            (id,user_id,base_url,model,models,temperature,max_output_tokens,api_key_secret_id,config_version,version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,$9)`,
          [
            config.id,
            config.userId,
            config.baseUrl,
            config.model,
            config.models,
            config.temperature,
            config.maxOutputTokens,
            secretId,
            config.createdAt,
          ],
        );
      }
      await client.query('COMMIT');
      return (await this.getModelConfig(config.userId))!;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async withUserConfigLock<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const client = await this.lockPool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [userId]);
      try {
        return await action();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [userId]);
      }
    } finally {
      client.release();
    }
  }

  async withIdempotencyLock<T>(scope: string, action: () => Promise<T>): Promise<T> {
    const client = await this.lockPool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [scope]);
      try {
        return await action();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [scope]);
      }
    } finally {
      client.release();
    }
  }

  async stageModelConfig(
    config: ModelConfigRecord,
    expectedVersion: number,
  ): Promise<ModelConfigStageRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        `SELECT m.*, s.ciphertext, s.hint
         FROM platform.model_configs m
         LEFT JOIN platform.secrets s ON s.id=m.api_key_secret_id AND s.revoked_at IS NULL
         WHERE m.user_id=$1`,
        [config.userId],
      );
      const current = currentResult.rows[0];
      if ((!current && expectedVersion !== 0) || (current && current.version !== expectedVersion)) {
        throw new HttpProblem(
          412,
          'version_conflict',
          'Model configuration version does not match',
        );
      }
      const stageId = crypto.randomUUID();
      const result = await client.query(
        `INSERT INTO platform.model_config_stages
          (id,config_id,user_id,base_version,config_version,base_url,model,models,temperature,
           max_output_tokens,api_key_ciphertext,api_key_hint,state,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',now(),now())
         RETURNING *`,
        [
          stageId,
          current?.id ?? config.id,
          config.userId,
          current?.version ?? 0,
          (current?.config_version ?? 0) + 1,
          config.baseUrl,
          config.model,
          config.models,
          config.temperature,
          config.maxOutputTokens,
          config.apiKeyCiphertext !== null
            ? Buffer.from(config.apiKeyCiphertext, 'utf8')
            : (current?.ciphertext ?? null),
          config.apiKeyHint ?? current?.hint ?? null,
        ],
      );
      await client.query('COMMIT');
      return mapModelConfigStage(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        throw new HttpProblem(
          409,
          'model_config_busy',
          'Model configuration update is in progress',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async activateModelConfig(stageId: string): Promise<ModelConfigRecord> {
    const client = await this.pool.connect();
    let userId: string | null = null;
    try {
      await client.query('BEGIN');
      const stageResult = await client.query(
        `SELECT * FROM platform.model_config_stages
         WHERE id=$1 AND state='pending' FOR UPDATE`,
        [stageId],
      );
      const row = stageResult.rows[0];
      if (!row) throw new Error('model_config_stage_not_pending');
      userId = row.user_id;
      const current = await client.query(
        'SELECT version FROM platform.model_configs WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      if ((current.rows[0]?.version ?? 0) !== row.base_version) {
        throw new HttpProblem(
          412,
          'version_conflict',
          'Model configuration version does not match',
        );
      }
      const ciphertext = row.api_key_ciphertext
        ? (row.api_key_ciphertext as Buffer).toString('utf8')
        : null;
      const secretId = ciphertext
        ? await this.putSecret(client, userId!, ciphertext, row.api_key_hint)
        : null;
      const activated = await client.query(
        `INSERT INTO platform.model_configs
          (id,user_id,base_url,model,models,temperature,max_output_tokens,api_key_secret_id,
           config_version,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
         ON CONFLICT (user_id) DO UPDATE SET
           base_url=excluded.base_url, model=excluded.model, models=excluded.models,
           temperature=excluded.temperature,
           max_output_tokens=excluded.max_output_tokens, api_key_secret_id=excluded.api_key_secret_id,
           config_version=excluded.config_version, version=excluded.version, updated_at=now()
         WHERE platform.model_configs.version=$11
         RETURNING id`,
        [
          row.config_id,
          userId,
          row.base_url,
          row.model,
          row.models,
          row.temperature,
          row.max_output_tokens,
          secretId,
          row.config_version,
          row.base_version + 1,
          row.base_version,
        ],
      );
      if (activated.rowCount === 0) {
        throw new HttpProblem(
          412,
          'version_conflict',
          'Model configuration version does not match',
        );
      }
      await client.query(
        `UPDATE platform.model_config_stages
         SET state='active', error_code=NULL, updated_at=now() WHERE id=$1`,
        [stageId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return (await this.getModelConfig(userId!))!;
  }

  async failModelConfigStage(stageId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE platform.model_config_stages
       SET state='failed', error_code=$2, updated_at=now()
       WHERE id=$1 AND state='pending'`,
      [stageId, errorCode.slice(0, 200)],
    );
  }

  private async putSecret(
    client: PoolClient,
    userId: string,
    ciphertext: string,
    hint: string | null,
  ): Promise<string> {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM platform.secrets
       WHERE owner_user_id=$1 AND purpose='model_api_key' AND revoked_at IS NULL FOR UPDATE`,
      [userId],
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE platform.secrets SET ciphertext=$2, hint=$3, key_version=key_version+1,
         version=version+1, updated_at=now() WHERE id=$1`,
        [existing.rows[0].id, Buffer.from(ciphertext, 'utf8'), hint],
      );
      return existing.rows[0].id;
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO platform.secrets(owner_user_id,purpose,ciphertext,key_version,hint)
       VALUES ($1,'model_api_key',$2,1,$3) RETURNING id`,
      [userId, Buffer.from(ciphertext, 'utf8'), hint],
    );
    return result.rows[0]!.id;
  }

  async getSession(userId: string, sessionId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM platform.sessions WHERE user_id=$1 AND session_id=$2',
      [userId, sessionId],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query('SELECT * FROM platform.sessions WHERE session_id=$1', [
      sessionId,
    ]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listSessions(userId: string, status?: SessionStatus): Promise<SessionRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM platform.sessions WHERE user_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY last_event_at DESC NULLS LAST, session_id`,
      [userId, status ?? null],
    );
    return result.rows.map(mapSession);
  }

  async upsertWorkspace(workspace: WorkspaceRecord): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO platform.workspaces
       (workspace_id,tenant_id,user_id,logical_name,storage_ref,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id) DO UPDATE SET
         logical_name=excluded.logical_name, storage_ref=excluded.storage_ref,
         version=platform.workspaces.version+1, updated_at=now()
       WHERE platform.workspaces.user_id=excluded.user_id
       RETURNING workspace_id`,
      [
        workspace.workspaceId,
        workspace.tenantId,
        workspace.userId,
        workspace.logicalName,
        workspace.storageRef,
        workspace.version,
        workspace.createdAt,
        workspace.updatedAt,
      ],
    );
    if (result.rowCount === 0)
      throw new HttpProblem(403, 'workspace_owner_mismatch', 'Workspace belongs to another user');
  }

  async upsertSession(session: SessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query(
      `INSERT INTO platform.sessions
       (session_id,tenant_id,user_id,workspace_id,title,status,last_event_position,last_event_at,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (session_id) DO UPDATE SET
         workspace_id=excluded.workspace_id, title=excluded.title, status=excluded.status,
         last_event_position=excluded.last_event_position, last_event_at=excluded.last_event_at,
         version=platform.sessions.version+1, updated_at=now()
       WHERE platform.sessions.user_id=excluded.user_id
       RETURNING *`,
      [
        session.sessionId,
        session.tenantId,
        session.userId,
        session.workspaceId,
        session.title,
        session.status,
        session.lastEventPosition,
        session.lastEventAt,
        session.version,
        session.createdAt,
        session.updatedAt,
      ],
    );
    if (result.rowCount === 0)
      throw new HttpProblem(403, 'session_owner_mismatch', 'Session belongs to another user');
    return mapSession(result.rows[0]!);
  }

  async archiveSession(
    userId: string,
    sessionId: string,
    expectedVersion: number,
  ): Promise<SessionRecord> {
    const result = await this.pool.query(
      `UPDATE platform.sessions SET status='archived', version=version+1, updated_at=now()
       WHERE user_id=$1 AND session_id=$2 AND version=$3 RETURNING *`,
      [userId, sessionId, expectedVersion],
    );
    if (result.rows[0]) return mapSession(result.rows[0]);
    if (await this.getSession(userId, sessionId))
      throw new HttpProblem(412, 'version_conflict', 'Session version does not match');
    throw new HttpProblem(404, 'session_not_found', 'Session was not found');
  }

  async appendAudit(event: AuditEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform.audit_events
       (id,tenant_id,actor_user_id,action,resource_type,resource_id,result,request_id,details,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        event.id,
        event.tenantId,
        event.actorUserId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.result,
        event.requestId,
        event.details,
        event.createdAt,
      ],
    );
  }

  async listAudit(): Promise<AuditEventRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM platform.audit_events ORDER BY created_at, id',
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      actorUserId: row.actor_user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      result: row.result,
      requestId: row.request_id,
      details: row.details,
      createdAt: row.created_at,
    }));
  }

  async getIdempotency(
    tenantId: string,
    actorUserId: string,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM platform.idempotency_records
       WHERE tenant_id=$1 AND actor_user_id=$2 AND route=$3 AND key=$4 AND expires_at>now()`,
      [tenantId, actorUserId, route, key],
    );
    const row = result.rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          actorUserId: row.actor_user_id,
          route: row.route,
          key: row.key,
          requestHash: row.request_hash,
          statusCode: row.status_code,
          response: row.response_json,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform.idempotency_records
       (tenant_id,actor_user_id,route,key,request_hash,status_code,response_json,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id,actor_user_id,route,key) DO UPDATE SET
         request_hash=EXCLUDED.request_hash,
         status_code=EXCLUDED.status_code,
         response_json=EXCLUDED.response_json,
         expires_at=EXCLUDED.expires_at,
         version=platform.idempotency_records.version+1,
         updated_at=now()
       WHERE platform.idempotency_records.expires_at<=now()`,
      [
        record.tenantId,
        record.actorUserId,
        record.route,
        record.key,
        record.requestHash,
        record.statusCode,
        record.response,
        record.expiresAt,
      ],
    );
  }
}

function mapModelConfigStage(row: QueryResultRow): ModelConfigStageRecord {
  return {
    stageId: row.id as string,
    id: row.config_id as string,
    userId: row.user_id as string,
    baseVersion: row.base_version as number,
    baseUrl: row.base_url as string,
    model: row.model as string,
    models: row.models as string[],
    temperature: Number(row.temperature),
    maxOutputTokens: row.max_output_tokens as number | null,
    apiKeyCiphertext: row.api_key_ciphertext
      ? (row.api_key_ciphertext as Buffer).toString('utf8')
      : null,
    apiKeyHint: row.api_key_hint as string | null,
    configVersion: row.config_version as number,
    version: (row.base_version as number) + 1,
    state: row.state as ModelConfigStageRecord['state'],
    errorCode: row.error_code as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}
