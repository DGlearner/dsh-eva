import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const platform = pgSchema('platform');

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const tenants = platform.table(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex('tenants_name_uq').on(sql`lower(${table.name})`)],
);

export const users = platform.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    platformRole: text('platform_role').notNull().default('member'),
    status: text('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('users_tenant_username_uq').on(table.tenantId, sql`lower(${table.username})`),
    index('users_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

export const localPasswordCredentials = platform.table('local_password_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  mustChange: boolean('must_change').notNull().default(false),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webSessions = platform.table(
  'web_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfHash: text('csrf_hash').notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('web_sessions_token_hash_uq').on(table.tokenHash),
    index('web_sessions_user_active_idx')
      .on(table.userId, table.idleExpiresAt)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const departments = platform.table(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('departments_tenant_name_active_uq')
      .on(table.tenantId, sql`lower(${table.name})`)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const departmentMembers = platform.table(
  'department_members',
  {
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgRole: text('org_role').notNull().default('member'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.departmentId, table.userId] }),
    uniqueIndex('department_members_user_uq').on(table.userId),
  ],
);

export const secrets = platform.table(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    hint: text('hint'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('secrets_owner_purpose_active_uq')
      .on(table.ownerUserId, table.purpose)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const modelConfigs = platform.table('model_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url').notNull(),
  model: text('model').notNull(),
  temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.70'),
  maxOutputTokens: integer('max_output_tokens'),
  apiKeySecretId: uuid('api_key_secret_id').references(() => secrets.id),
  configVersion: integer('config_version').notNull().default(1),
  version: integer('version').notNull().default(1),
  ...timestamps,
});

export const workspaces = platform.table(
  'workspaces',
  {
    workspaceId: text('workspace_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    logicalName: text('logical_name').notNull(),
    storageRef: text('storage_ref').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [index('workspaces_user_created_idx').on(table.userId, table.createdAt)],
);

export const sessions = platform.table(
  'sessions',
  {
    sessionId: text('session_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    title: text('title'),
    status: text('status').notNull().default('active'),
    lastEventPosition: bigint('last_event_position', { mode: 'number' }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index('sessions_user_last_event_idx').on(table.userId, table.lastEventAt, table.sessionId),
  ],
);

export const runnerInstances = platform.table(
  'runner_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    containerId: text('container_id'),
    imageVersion: text('image_version').notNull(),
    state: text('state').notNull().default('starting'),
    internalEndpoint: text('internal_endpoint'),
    configVersion: integer('config_version').notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('runner_instances_container_uq')
      .on(table.containerId)
      .where(sql`${table.containerId} is not null`),
    uniqueIndex('runner_instances_user_primary_uq')
      .on(table.userId)
      .where(sql`${table.state} in ('starting', 'ready', 'busy', 'idle', 'stopping')`),
    index('runner_instances_state_idx').on(table.state, table.updatedAt),
  ],
);

export const knowledgeProviderConfigs = platform.table('knowledge_provider_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .unique()
    .references(() => tenants.id),
  provider: text('provider').notNull().default('fake'),
  remoteMcpEnabled: boolean('remote_mcp_enabled').notNull().default(false),
  endpoint: text('endpoint'),
  authSecretId: uuid('auth_secret_id').references(() => secrets.id),
  allowedTools: jsonb('allowed_tools')
    .notNull()
    .default(sql`'["get_current_user","search_knowledge","list_knowledge_documents"]'::jsonb`),
  configVersion: integer('config_version').notNull().default(1),
  version: integer('version').notNull().default(1),
  ...timestamps,
});

export const ragUserBindings = platform.table('rag_user_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  ragEmployeeId: text('rag_employee_id').notNull().unique(),
  tokenSecretId: uuid('token_secret_id').references(() => secrets.id),
  status: text('status').notNull().default('inactive'),
  version: integer('version').notNull().default(1),
  ...timestamps,
});

export const idempotencyRecords = platform.table(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    route: text('route').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    responseJson: jsonb('response_json'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('idempotency_records_scope_uq').on(
      table.tenantId,
      table.actorUserId,
      table.route,
      table.key,
    ),
    index('idempotency_records_expires_idx').on(table.expiresAt),
  ],
);

export const auditEvents = platform.table(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    result: text('result').notNull(),
    requestId: text('request_id').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_actor_time_idx').on(table.actorUserId, table.createdAt),
    index('audit_events_resource_time_idx').on(
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    index('audit_events_request_idx').on(table.requestId),
  ],
);
