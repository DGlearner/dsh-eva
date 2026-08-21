import { randomUUID } from 'node:crypto';

import type {
  AuditEventRecord,
  DepartmentRecord,
  IdempotencyRecord,
  MembershipRecord,
  ModelConfigRecord,
  ModelConfigStageRecord,
  PlatformRepository,
  SessionRecord,
  SessionStatus,
  UserRecord,
  UserStatus,
  WebSessionRecord,
  WorkspaceRecord,
} from './domain.js';
import { HttpProblem } from './problems.js';

export class MemoryPlatformRepository implements PlatformRepository {
  readonly users = new Map<string, UserRecord>();
  readonly departments = new Map<string, DepartmentRecord>();
  readonly memberships = new Map<string, MembershipRecord>();
  readonly webSessions = new Map<string, WebSessionRecord>();
  readonly modelConfigs = new Map<string, ModelConfigRecord>();
  readonly modelConfigStages = new Map<string, ModelConfigStageRecord>();
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly audits: AuditEventRecord[] = [];
  readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly configLocks = new Map<string, Promise<void>>();
  private readonly idempotencyLocks = new Map<string, Promise<void>>();

  constructor(readonly tenantId: string) {}

  async getDefaultTenantId(): Promise<string> {
    return this.tenantId;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const normalized = username.trim().toLocaleLowerCase('en-US');
    return (
      [...this.users.values()].find(
        (user) =>
          user.tenantId === this.tenantId &&
          user.username.toLocaleLowerCase('en-US') === normalized,
      ) ?? null
    );
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async listUsers(tenantId: string, status?: UserStatus): Promise<UserRecord[]> {
    return [...this.users.values()]
      .filter((user) => user.tenantId === tenantId && (!status || user.status === status))
      .sort((left, right) => left.username.localeCompare(right.username));
  }

  async createUser(user: UserRecord): Promise<void> {
    if (await this.findUserByUsername(user.username)) {
      throw new HttpProblem(409, 'username_conflict', 'Username is already in use');
    }
    this.users.set(user.id, structuredClone(user));
  }

  async updateUser(
    userId: string,
    expectedVersion: number,
    patch: Partial<Pick<UserRecord, 'displayName' | 'platformRole' | 'status'>>,
  ): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new HttpProblem(404, 'user_not_found', 'User was not found');
    if (user.version !== expectedVersion) {
      throw new HttpProblem(412, 'version_conflict', 'User version does not match');
    }
    const updated = { ...user, ...patch, version: user.version + 1, updatedAt: new Date() };
    this.users.set(userId, updated);
    return structuredClone(updated);
  }

  async replacePassword(userId: string, passwordHash: string, mustChange: boolean): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new HttpProblem(404, 'user_not_found', 'User was not found');
    this.users.set(userId, {
      ...user,
      passwordHash,
      mustChangePassword: mustChange,
      updatedAt: new Date(),
    });
  }

  async createWebSession(session: WebSessionRecord): Promise<void> {
    this.webSessions.set(session.id, structuredClone(session));
  }

  async getWebSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | null> {
    return (
      [...this.webSessions.values()].find((session) => session.tokenHash === tokenHash) ?? null
    );
  }

  async touchWebSession(sessionId: string, idleExpiresAt: Date): Promise<void> {
    const session = this.webSessions.get(sessionId);
    if (session) {
      this.webSessions.set(sessionId, { ...session, idleExpiresAt, updatedAt: new Date() });
    }
  }

  async revokeWebSession(sessionId: string): Promise<void> {
    const session = this.webSessions.get(sessionId);
    if (session && !session.revokedAt) {
      this.webSessions.set(sessionId, { ...session, revokedAt: new Date(), updatedAt: new Date() });
    }
  }

  async revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
    for (const [id, session] of this.webSessions) {
      if (session.userId === userId && id !== exceptSessionId && !session.revokedAt) {
        this.webSessions.set(id, { ...session, revokedAt: new Date(), updatedAt: new Date() });
      }
    }
  }

  async getMembership(userId: string): Promise<MembershipRecord | null> {
    return this.memberships.get(userId) ?? null;
  }

  async putMembership(
    membership: MembershipRecord,
    expectedVersion: number,
  ): Promise<MembershipRecord> {
    const existing = this.memberships.get(membership.userId);
    if (
      (!existing && expectedVersion !== 0) ||
      (existing && existing.version !== expectedVersion)
    ) {
      throw new HttpProblem(412, 'version_conflict', 'Membership version does not match');
    }
    const updated = {
      ...membership,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? membership.createdAt,
      updatedAt: new Date(),
    };
    this.memberships.set(membership.userId, updated);
    return structuredClone(updated);
  }

  async listDepartments(tenantId: string): Promise<DepartmentRecord[]> {
    return [...this.departments.values()]
      .filter((department) => department.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getDepartment(departmentId: string): Promise<DepartmentRecord | null> {
    return this.departments.get(departmentId) ?? null;
  }

  async createDepartment(department: DepartmentRecord): Promise<void> {
    const duplicate = [...this.departments.values()].some(
      (candidate) =>
        candidate.tenantId === department.tenantId &&
        candidate.status === 'active' &&
        candidate.name.toLocaleLowerCase('en-US') === department.name.toLocaleLowerCase('en-US'),
    );
    if (duplicate) {
      throw new HttpProblem(409, 'department_name_conflict', 'Department name is already in use');
    }
    this.departments.set(department.id, structuredClone(department));
  }

  async getModelConfig(userId: string): Promise<ModelConfigRecord | null> {
    return this.modelConfigs.get(userId) ?? null;
  }

  async putModelConfig(
    config: ModelConfigRecord,
    expectedVersion: number,
  ): Promise<ModelConfigRecord> {
    const existing = this.modelConfigs.get(config.userId);
    if (
      (!existing && expectedVersion !== 0) ||
      (existing && existing.version !== expectedVersion)
    ) {
      throw new HttpProblem(412, 'version_conflict', 'Model configuration version does not match');
    }
    const updated = {
      ...config,
      id: existing?.id ?? config.id,
      apiKeyCiphertext: config.apiKeyCiphertext ?? existing?.apiKeyCiphertext ?? null,
      apiKeyHint: config.apiKeyHint ?? existing?.apiKeyHint ?? null,
      configVersion: (existing?.configVersion ?? 0) + 1,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? config.createdAt,
      updatedAt: new Date(),
    };
    this.modelConfigs.set(config.userId, updated);
    return structuredClone(updated);
  }

  async withUserConfigLock<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.configLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.configLocks.set(userId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.configLocks.get(userId) === queued) this.configLocks.delete(userId);
    }
  }

  async withIdempotencyLock<T>(scope: string, action: () => Promise<T>): Promise<T> {
    const previous = this.idempotencyLocks.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.idempotencyLocks.set(scope, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.idempotencyLocks.get(scope) === queued) this.idempotencyLocks.delete(scope);
    }
  }

  async stageModelConfig(
    config: ModelConfigRecord,
    expectedVersion: number,
  ): Promise<ModelConfigStageRecord> {
    const existing = this.modelConfigs.get(config.userId);
    if (
      (!existing && expectedVersion !== 0) ||
      (existing && existing.version !== expectedVersion)
    ) {
      throw new HttpProblem(412, 'version_conflict', 'Model configuration version does not match');
    }
    if (
      [...this.modelConfigStages.values()].some(
        (stage) => stage.userId === config.userId && stage.state === 'pending',
      )
    ) {
      throw new HttpProblem(409, 'model_config_busy', 'Model configuration update is in progress');
    }
    const now = new Date();
    const stage: ModelConfigStageRecord = {
      ...config,
      stageId: randomUUID(),
      id: existing?.id ?? config.id,
      baseVersion: existing?.version ?? 0,
      configVersion: (existing?.configVersion ?? 0) + 1,
      version: (existing?.version ?? 0) + 1,
      apiKeyCiphertext: config.apiKeyCiphertext ?? existing?.apiKeyCiphertext ?? null,
      apiKeyHint: config.apiKeyHint ?? existing?.apiKeyHint ?? null,
      state: 'pending',
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    this.modelConfigStages.set(stage.stageId, stage);
    return structuredClone(stage);
  }

  async activateModelConfig(stageId: string): Promise<ModelConfigRecord> {
    const stage = this.modelConfigStages.get(stageId);
    if (!stage || stage.state !== 'pending') throw new Error('model_config_stage_not_pending');
    const current = this.modelConfigs.get(stage.userId);
    if ((current?.version ?? 0) !== stage.baseVersion) {
      throw new HttpProblem(412, 'version_conflict', 'Model configuration version does not match');
    }
    const {
      stageId: _stageId,
      baseVersion: _baseVersion,
      state: _state,
      errorCode: _error,
      ...config
    } = stage;
    this.modelConfigs.set(stage.userId, config);
    this.modelConfigStages.set(stageId, { ...stage, state: 'active', updatedAt: new Date() });
    return structuredClone(config);
  }

  async failModelConfigStage(stageId: string, errorCode: string): Promise<void> {
    const stage = this.modelConfigStages.get(stageId);
    if (stage?.state === 'pending') {
      this.modelConfigStages.set(stageId, {
        ...stage,
        state: 'failed',
        errorCode,
        updatedAt: new Date(),
      });
    }
  }

  async getSession(userId: string, sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session?.userId === userId ? structuredClone(session) : null;
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(userId: string, status?: SessionStatus): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && (!status || session.status === status))
      .sort(
        (left, right) =>
          (right.lastEventAt?.getTime() ?? 0) - (left.lastEventAt?.getTime() ?? 0) ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  async upsertWorkspace(workspace: WorkspaceRecord): Promise<void> {
    const existing = this.workspaces.get(workspace.workspaceId);
    if (existing && existing.userId !== workspace.userId) {
      throw new HttpProblem(403, 'workspace_owner_mismatch', 'Workspace belongs to another user');
    }
    this.workspaces.set(
      workspace.workspaceId,
      existing ? { ...existing, ...workspace } : workspace,
    );
  }

  async upsertSession(session: SessionRecord): Promise<SessionRecord> {
    const existing = this.sessions.get(session.sessionId);
    if (existing && existing.userId !== session.userId) {
      throw new HttpProblem(403, 'session_owner_mismatch', 'Session belongs to another user');
    }
    const updated = existing
      ? {
          ...existing,
          ...session,
          createdAt: existing.createdAt,
          version: existing.version + 1,
          updatedAt: new Date(),
        }
      : session;
    this.sessions.set(session.sessionId, updated);
    return structuredClone(updated);
  }

  async archiveSession(
    userId: string,
    sessionId: string,
    expectedVersion: number,
  ): Promise<SessionRecord> {
    const session = await this.getSession(userId, sessionId);
    if (!session) throw new HttpProblem(404, 'session_not_found', 'Session was not found');
    if (session.version !== expectedVersion) {
      throw new HttpProblem(412, 'version_conflict', 'Session version does not match');
    }
    const updated = { ...session, status: 'archived' as const, version: session.version + 1 };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async appendAudit(event: AuditEventRecord): Promise<void> {
    this.audits.push(structuredClone(event));
  }

  async listAudit(): Promise<AuditEventRecord[]> {
    return structuredClone(this.audits);
  }

  private idempotencyKey(
    tenantId: string,
    actorUserId: string,
    route: string,
    key: string,
  ): string {
    return `${tenantId}:${actorUserId}:${route}:${key}`;
  }

  async getIdempotency(
    tenantId: string,
    actorUserId: string,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const record = this.idempotency.get(this.idempotencyKey(tenantId, actorUserId, route, key));
    if (!record || record.expiresAt <= new Date()) return null;
    return structuredClone(record);
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(
      this.idempotencyKey(record.tenantId, record.actorUserId, record.route, record.key),
      structuredClone(record),
    );
  }

  static empty(): MemoryPlatformRepository {
    return new MemoryPlatformRepository(randomUUID());
  }
}
