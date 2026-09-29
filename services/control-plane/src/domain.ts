export type PlatformRole = 'admin' | 'member';
export type OrgRole = 'manager' | 'member';
export type UserStatus = 'active' | 'disabled';
export type SessionStatus = 'active' | 'archived' | 'interrupted' | 'corrupted';

export type UserRecord = {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  platformRole: PlatformRole;
  status: UserStatus;
  version: number;
  passwordHash: string;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type DepartmentRecord = {
  id: string;
  tenantId: string;
  name: string;
  status: UserStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MembershipRecord = {
  departmentId: string;
  userId: string;
  orgRole: OrgRole;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type WebSessionRecord = {
  id: string;
  tokenHash: string;
  csrfHash: string;
  userId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelConfigRecord = {
  id: string;
  userId: string;
  baseUrl: string;
  model: string;
  models: string[];
  temperature: number;
  maxOutputTokens: number | null;
  apiKeyCiphertext: string | null;
  apiKeyHint: string | null;
  configVersion: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelConfigStageRecord = ModelConfigRecord & {
  stageId: string;
  baseVersion: number;
  state: 'pending' | 'active' | 'failed';
  errorCode: string | null;
};

export type KnowledgeProviderRecord = {
  tenantId: string;
  provider: 'disabled' | 'fake' | 'remote-mcp';
  remoteMcpEnabled: boolean;
  endpoint: string | null;
  allowedTools: string[];
  configVersion: number;
  version: number;
};

export type RagUserBindingRecord = {
  userId: string;
  ragEmployeeId: string;
  tokenCiphertext: string | null;
  tokenHint: string | null;
  status: 'inactive' | 'active' | 'revoked';
  version: number;
};

export type WorkspaceRecord = {
  workspaceId: string;
  tenantId: string;
  userId: string;
  logicalName: string;
  storageRef: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionRecord = {
  sessionId: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  title: string | null;
  status: SessionStatus;
  lastEventPosition: number | null;
  lastEventAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AuditEventRecord = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: 'success' | 'failure' | 'denied';
  requestId: string;
  details: Record<string, unknown>;
  createdAt: Date;
};

export type IdempotencyRecord = {
  tenantId: string;
  actorUserId: string;
  route: string;
  key: string;
  requestHash: string;
  statusCode: number;
  response: unknown;
  expiresAt: Date;
};

export type AuthContext = {
  session: WebSessionRecord;
  user: UserRecord;
  membership: MembershipRecord | null;
  department: DepartmentRecord | null;
  csrfToken: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export interface PlatformRepository {
  getDefaultTenantId(): Promise<string>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  getUser(userId: string): Promise<UserRecord | null>;
  listUsers(tenantId: string, status?: UserStatus): Promise<UserRecord[]>;
  createUser(user: UserRecord): Promise<void>;
  updateUser(
    userId: string,
    expectedVersion: number,
    patch: Partial<Pick<UserRecord, 'displayName' | 'platformRole' | 'status'>>,
  ): Promise<UserRecord>;
  replacePassword(userId: string, passwordHash: string, mustChange: boolean): Promise<void>;

  createWebSession(session: WebSessionRecord): Promise<void>;
  getWebSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | null>;
  touchWebSession(sessionId: string, idleExpiresAt: Date): Promise<void>;
  revokeWebSession(sessionId: string): Promise<void>;
  revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void>;

  getMembership(userId: string): Promise<MembershipRecord | null>;
  putMembership(membership: MembershipRecord, expectedVersion: number): Promise<MembershipRecord>;
  listDepartments(tenantId: string): Promise<DepartmentRecord[]>;
  getDepartment(departmentId: string): Promise<DepartmentRecord | null>;
  createDepartment(department: DepartmentRecord): Promise<void>;

  getModelConfig(userId: string): Promise<ModelConfigRecord | null>;
  putModelConfig(config: ModelConfigRecord, expectedVersion: number): Promise<ModelConfigRecord>;
  withUserConfigLock<T>(userId: string, action: () => Promise<T>): Promise<T>;
  withIdempotencyLock<T>(scope: string, action: () => Promise<T>): Promise<T>;
  stageModelConfig(
    config: ModelConfigRecord,
    expectedVersion: number,
  ): Promise<ModelConfigStageRecord>;
  activateModelConfig(stageId: string): Promise<ModelConfigRecord>;
  failModelConfigStage(stageId: string, errorCode: string): Promise<void>;

  getKnowledgeProviderConfig(tenantId: string): Promise<KnowledgeProviderRecord | null>;
  getRagUserBinding(userId: string): Promise<RagUserBindingRecord | null>;

  getSession(userId: string, sessionId: string): Promise<SessionRecord | null>;
  getSessionById(sessionId: string): Promise<SessionRecord | null>;
  listSessions(userId: string, status?: SessionStatus): Promise<SessionRecord[]>;
  upsertWorkspace(workspace: WorkspaceRecord): Promise<void>;
  upsertSession(session: SessionRecord): Promise<SessionRecord>;
  archiveSession(
    userId: string,
    sessionId: string,
    expectedVersion: number,
  ): Promise<SessionRecord>;

  appendAudit(event: AuditEventRecord): Promise<void>;
  listAudit(): Promise<AuditEventRecord[]>;
  getIdempotency(
    tenantId: string,
    actorUserId: string,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
}
