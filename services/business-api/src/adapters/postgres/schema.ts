import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type {
  AutomationResult,
  DailyReportContent,
  EvidenceItem,
  KnowledgeChunk,
  ReviewCheck,
} from '../../domain/models.js';

const platform = pgSchema('platform');
export const platformUsers = platform.table('users', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  platformRole: text('platform_role').notNull(),
  status: text('status').notNull(),
});
export const platformDepartments = platform.table('departments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
});
export const platformDepartmentMembers = platform.table(
  'department_members',
  {
    departmentId: uuid('department_id').notNull(),
    userId: uuid('user_id').notNull(),
    orgRole: text('org_role').notNull(),
  },
  (table) => [primaryKey({ columns: [table.departmentId, table.userId] })],
);

const business = pgSchema('business');
export const requirements = business.table(
  'requirements',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    departmentId: uuid('department_id').notNull(),
    publisherUserId: uuid('publisher_user_id').notNull(),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
    status: text('status').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('requirements_department_status_idx').on(
      table.departmentId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const tasks = business.table(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    requirementId: uuid('requirement_id').notNull(),
    parentTaskId: uuid('parent_task_id'),
    departmentId: uuid('department_id').notNull(),
    assigneeUserId: uuid('assignee_user_id'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
    status: text('status').notNull(),
    position: integer('position').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'string' }),
    latestReviewResult: text('latest_review_result'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('tasks_requirement_position_idx').on(table.requirementId, table.position)],
);

export const taskDependencies = business.table(
  'task_dependencies',
  {
    taskId: uuid('task_id').notNull(),
    dependsOnTaskId: uuid('depends_on_task_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.dependsOnTaskId] })],
);

export const taskStatusHistory = business.table('task_status_history', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const taskSubmissions = business.table('task_submissions', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  submitterUserId: uuid('submitter_user_id').notNull(),
  summary: text('summary').notNull(),
  evidence: jsonb('evidence').$type<EvidenceItem[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const automationOperations = business.table(
  'automation_operations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    kind: text('kind').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    provider: text('provider').notNull(),
    providerRunId: uuid('provider_run_id'),
    status: text('status').notNull(),
    result: jsonb('result').$type<AutomationResult>(),
    error: jsonb('error').$type<{ code: string; message: string }>(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('automation_operations_provider_run_uq').on(table.providerRunId),
    index('automation_operations_tenant_resource_idx').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
    ),
  ],
);

export const taskReviewRuns = business.table('task_review_runs', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  submissionId: uuid('submission_id').notNull(),
  automationRunId: uuid('automation_run_id').notNull(),
  status: text('status').notNull(),
  result: text('result'),
  summary: text('summary'),
  checks: jsonb('checks').$type<ReviewCheck[]>().notNull(),
  evidence: jsonb('evidence').$type<EvidenceItem[]>().notNull(),
  executorVersion: text('executor_version').notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
});

export const dailyReports = business.table(
  'daily_reports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    departmentId: uuid('department_id').notNull(),
    workDate: date('work_date', { mode: 'string' }).notNull(),
    content: jsonb('content').$type<DailyReportContent>().notNull(),
    status: text('status').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('daily_reports_tenant_user_date_uq').on(
      table.tenantId,
      table.userId,
      table.workDate,
    ),
  ],
);

export const dailyReportRevisions = business.table('daily_report_revisions', {
  id: uuid('id').primaryKey(),
  reportId: uuid('report_id').notNull(),
  editorUserId: uuid('editor_user_id').notNull(),
  source: text('source').notNull(),
  beforeContent: jsonb('before_content').$type<DailyReportContent>(),
  afterContent: jsonb('after_content').$type<DailyReportContent>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const idempotencyRecords = business.table(
  'idempotency_records',
  {
    tenantId: uuid('tenant_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    route: text('route').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    responseJson: jsonb('response_json').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.actorUserId, table.route, table.key] })],
);

export const auditEvents = business.table('audit_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  result: text('result').notNull(),
  requestId: text('request_id').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const fakeKnowledgeDocuments = business.table('fake_knowledge_documents', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  fixtureKey: text('fixture_key').notNull(),
  knowledgeId: text('knowledge_id').notNull(),
  ownerUserId: uuid('owner_user_id'),
  scope: text('scope').notNull(),
  category: text('category'),
  title: text('title').notNull(),
  fileName: text('file_name').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  contentChunks: jsonb('content_chunks').$type<KnowledgeChunk[]>().notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const fakeKnowledgeUploads = business.table('fake_knowledge_uploads', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  ownerUserId: uuid('owner_user_id').notNull(),
  status: text('status').notNull(),
  progress: integer('progress').notNull(),
  errorCode: text('error_code'),
  scenario: text('scenario').notNull(),
  pollCount: integer('poll_count').notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});
