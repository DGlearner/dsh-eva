import { AsyncLocalStorage } from 'node:async_hooks';

import { and, asc, desc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { conflict, versionConflict } from '../../domain/errors.js';
import type {
  AuditEvent,
  AutomationOperation,
  DailyReport,
  DailyReportRevision,
  Department,
  IdempotencyRecord,
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeScope,
  KnowledgeUpload,
  Requirement,
  Task,
  TaskDependency,
  TaskReviewRun,
  TaskStatusHistory,
  TaskSubmission,
  UserSummary,
  UUID,
} from '../../domain/models.js';
import type { BusinessRepository, NewKnowledgeUpload } from '../../ports/repository.js';
import * as schema from './schema.js';

type Database = NodePgDatabase<typeof schema>;

const companyCategories: KnowledgeCategory[] = [
  { code: 'company-information', name: '公司信息', scope: 'company' },
  { code: 'xiaopai-design', name: '小派设计', scope: 'company' },
  { code: 'patent-document', name: '专利文档', scope: 'company' },
];

export class PostgresBusinessRepository implements BusinessRepository {
  readonly pool: Pool | null;
  private readonly client: Pool | PoolClient;
  private readonly baseDb: Database;
  private readonly transactionContext = new AsyncLocalStorage<{
    client: PoolClient;
    db: Database;
  }>();
  private savepointSequence = 0;

  constructor(connection: string | Pool | PoolClient) {
    const client =
      typeof connection === 'string' ? new Pool({ connectionString: connection }) : connection;
    this.client = client;
    this.pool = client instanceof Pool ? client : null;
    this.baseDb = drizzle(client, { schema });
  }

  private get db(): Database {
    return this.transactionContext.getStore()?.db ?? this.baseDb;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async healthCheck(): Promise<void> {
    await this.client.query('select 1');
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() !== undefined) return work();

    if (this.pool === null) {
      const client = this.client as PoolClient;
      const savepoint = `business_uow_${++this.savepointSequence}`;
      await client.query(`savepoint ${savepoint}`);
      return this.transactionContext.run({ client, db: this.baseDb }, async (): Promise<T> => {
        try {
          const result = await work();
          await client.query(`release savepoint ${savepoint}`);
          return result;
        } catch (error) {
          await client.query(`rollback to savepoint ${savepoint}`);
          await client.query(`release savepoint ${savepoint}`);
          throw error;
        }
      });
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await this.transactionContext.run(
        { client, db: drizzle(client, { schema }) },
        work,
      );
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async withIdempotencyLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const transaction = this.transactionContext.getStore();
    if (transaction === undefined) {
      return this.transaction(() => this.withIdempotencyLock(scope, work));
    }
    await transaction.client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      scope,
    ]);
    return work();
  }

  async listKnowledgeCategories(scope: KnowledgeScope): Promise<KnowledgeCategory[]> {
    return scope === 'company' ? structuredClone(companyCategories) : [];
  }

  async listKnowledgeDocuments(tenantId: UUID): Promise<KnowledgeDocument[]> {
    const rows = await this.db
      .select()
      .from(schema.fakeKnowledgeDocuments)
      .where(eq(schema.fakeKnowledgeDocuments.tenantId, tenantId))
      .orderBy(
        desc(schema.fakeKnowledgeDocuments.updatedAt),
        asc(schema.fakeKnowledgeDocuments.id),
      );
    return rows.map(mapDocument);
  }

  async getKnowledgeDocument(tenantId: UUID, documentId: UUID): Promise<KnowledgeDocument | null> {
    const [row] = await this.db
      .select()
      .from(schema.fakeKnowledgeDocuments)
      .where(
        and(
          eq(schema.fakeKnowledgeDocuments.tenantId, tenantId),
          eq(schema.fakeKnowledgeDocuments.id, documentId),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapDocument(row);
  }

  async createKnowledgeUpload(value: NewKnowledgeUpload): Promise<void> {
    await this.transaction(async () => {
      const tenantId = await this.tenantForUser(value.upload.owner_user_id);
      await this.db.insert(schema.fakeKnowledgeDocuments).values({
        id: value.document.id,
        tenantId,
        fixtureKey: `runtime-${value.document.id}`,
        knowledgeId: value.document.knowledge_id,
        ownerUserId: value.document.owner_user_id,
        scope: value.document.scope,
        category: value.document.category,
        title: value.document.title,
        fileName: value.document.file_name,
        mediaType: value.document.media_type,
        sizeBytes: value.document.size_bytes,
        status: value.document.status,
        contentChunks: [],
        version: value.document.version,
        createdAt: value.upload.created_at,
        updatedAt: value.document.updated_at,
      });
      await this.db
        .insert(schema.fakeKnowledgeUploads)
        .values(mapUploadInsert(tenantId, value.upload));
    });
  }

  async createKnowledgeReindex(upload: KnowledgeUpload): Promise<void> {
    const tenantId = await this.tenantForUser(upload.owner_user_id);
    await this.db.insert(schema.fakeKnowledgeUploads).values(mapUploadInsert(tenantId, upload));
  }

  async getKnowledgeUpload(tenantId: UUID, uploadId: UUID): Promise<KnowledgeUpload | null> {
    const [row] = await this.db
      .select()
      .from(schema.fakeKnowledgeUploads)
      .where(
        and(
          eq(schema.fakeKnowledgeUploads.tenantId, tenantId),
          eq(schema.fakeKnowledgeUploads.id, uploadId),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapUpload(row);
  }

  async saveKnowledgeUpload(upload: KnowledgeUpload, expectedVersion: number): Promise<void> {
    const changed = await this.db
      .update(schema.fakeKnowledgeUploads)
      .set({
        status: upload.status,
        progress: upload.progress,
        errorCode: upload.error_code,
        scenario: upload.scenario ?? 'success',
        pollCount: upload.poll_count ?? 0,
        version: upload.version,
        updatedAt: upload.updated_at,
      })
      .where(
        and(
          eq(schema.fakeKnowledgeUploads.id, upload.id),
          eq(schema.fakeKnowledgeUploads.version, expectedVersion),
        ),
      )
      .returning({ version: schema.fakeKnowledgeUploads.version });
    if (changed.length === 0) await this.throwVersion(schema.fakeKnowledgeUploads, upload.id);
  }

  async saveKnowledgeDocument(document: KnowledgeDocument, expectedVersion: number): Promise<void> {
    const changed = await this.db
      .update(schema.fakeKnowledgeDocuments)
      .set({
        status: document.status,
        title: document.title,
        version: document.version,
        updatedAt: document.updated_at,
      })
      .where(
        and(
          eq(schema.fakeKnowledgeDocuments.id, document.id),
          eq(schema.fakeKnowledgeDocuments.version, expectedVersion),
        ),
      )
      .returning({ version: schema.fakeKnowledgeDocuments.version });
    if (changed.length === 0) await this.throwDocumentVersion(document.id);
  }

  async listRequirements(tenantId: UUID): Promise<Requirement[]> {
    const rows = await this.db
      .select()
      .from(schema.requirements)
      .where(eq(schema.requirements.tenantId, tenantId))
      .orderBy(desc(schema.requirements.updatedAt), asc(schema.requirements.id));
    return rows.map(mapRequirement);
  }

  async getRequirement(tenantId: UUID, requirementId: UUID): Promise<Requirement | null> {
    const [row] = await this.db
      .select()
      .from(schema.requirements)
      .where(
        and(eq(schema.requirements.tenantId, tenantId), eq(schema.requirements.id, requirementId)),
      )
      .limit(1);
    return row === undefined ? null : mapRequirement(row);
  }

  async createRequirement(value: Requirement): Promise<void> {
    await this.db.insert(schema.requirements).values({
      id: value.id,
      tenantId: value.tenant_id,
      departmentId: value.department_id,
      publisherUserId: value.publisher_user_id,
      title: value.title,
      objective: value.objective,
      acceptanceCriteria: value.acceptance_criteria,
      status: value.status,
      publishedAt: value.published_at,
      version: value.version,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    });
  }

  async saveRequirement(value: Requirement, expectedVersion: number): Promise<void> {
    const changed = await this.db
      .update(schema.requirements)
      .set({
        title: value.title,
        objective: value.objective,
        acceptanceCriteria: value.acceptance_criteria,
        status: value.status,
        publishedAt: value.published_at,
        version: value.version,
        updatedAt: value.updated_at,
      })
      .where(
        and(eq(schema.requirements.id, value.id), eq(schema.requirements.version, expectedVersion)),
      )
      .returning({ version: schema.requirements.version });
    if (changed.length === 0) await this.throwVersion(schema.requirements, value.id);
  }

  async listTasks(tenantId: UUID): Promise<Task[]> {
    const rows = await this.db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .innerJoin(schema.requirements, eq(schema.tasks.requirementId, schema.requirements.id))
      .where(eq(schema.requirements.tenantId, tenantId))
      .orderBy(desc(schema.tasks.updatedAt), asc(schema.tasks.id));
    return rows.map(({ task }) => mapTask(task));
  }

  async getTask(tenantId: UUID, taskId: UUID): Promise<Task | null> {
    const [row] = await this.db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .innerJoin(schema.requirements, eq(schema.tasks.requirementId, schema.requirements.id))
      .where(and(eq(schema.requirements.tenantId, tenantId), eq(schema.tasks.id, taskId)))
      .limit(1);
    return row === undefined ? null : mapTask(row.task);
  }

  async createTasks(values: Task[], dependencies: TaskDependency[]): Promise<void> {
    await this.transaction(async () => {
      if (values.length > 0) {
        await this.db.insert(schema.tasks).values(
          values.map((value) => ({
            id: value.id,
            requirementId: value.requirement_id,
            parentTaskId: value.parent_task_id,
            departmentId: value.department_id,
            assigneeUserId: value.assignee_user_id,
            title: value.title,
            description: value.description,
            acceptanceCriteria: value.acceptance_criteria,
            status: value.status,
            position: value.position,
            dueAt: value.due_at,
            latestReviewResult: value.latest_review_result,
            version: value.version,
            createdAt: value.created_at,
            updatedAt: value.updated_at,
          })),
        );
      }
      if (dependencies.length > 0) {
        await this.db.insert(schema.taskDependencies).values(
          dependencies.map((value) => ({
            taskId: value.task_id,
            dependsOnTaskId: value.depends_on_task_id,
          })),
        );
      }
    });
  }

  async saveTask(value: Task, expectedVersion: number): Promise<void> {
    const changed = await this.db
      .update(schema.tasks)
      .set({
        assigneeUserId: value.assignee_user_id,
        title: value.title,
        description: value.description,
        acceptanceCriteria: value.acceptance_criteria,
        status: value.status,
        position: value.position,
        dueAt: value.due_at,
        latestReviewResult: value.latest_review_result,
        version: value.version,
        updatedAt: value.updated_at,
      })
      .where(and(eq(schema.tasks.id, value.id), eq(schema.tasks.version, expectedVersion)))
      .returning({ version: schema.tasks.version });
    if (changed.length === 0) await this.throwVersion(schema.tasks, value.id);
  }

  async listTaskDependencies(taskId: UUID): Promise<TaskDependency[]> {
    const rows = await this.db
      .select()
      .from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.taskId, taskId));
    return rows.map((row) => ({ task_id: row.taskId, depends_on_task_id: row.dependsOnTaskId }));
  }

  async listTaskSubmissions(taskId: UUID): Promise<TaskSubmission[]> {
    const rows = await this.db
      .select()
      .from(schema.taskSubmissions)
      .where(eq(schema.taskSubmissions.taskId, taskId))
      .orderBy(asc(schema.taskSubmissions.createdAt));
    return rows.map(mapSubmission);
  }

  async addTaskSubmission(value: TaskSubmission): Promise<void> {
    await this.db.insert(schema.taskSubmissions).values({
      id: value.id,
      taskId: value.task_id,
      submitterUserId: value.submitter_user_id,
      summary: value.summary,
      evidence: value.evidence,
      createdAt: value.created_at,
    });
  }

  async listTaskReviewRuns(taskId: UUID): Promise<TaskReviewRun[]> {
    const rows = await this.db
      .select()
      .from(schema.taskReviewRuns)
      .where(eq(schema.taskReviewRuns.taskId, taskId))
      .orderBy(asc(schema.taskReviewRuns.createdAt));
    return rows.map(mapReview);
  }

  async addTaskReviewRun(value: TaskReviewRun): Promise<void> {
    await this.db.insert(schema.taskReviewRuns).values(reviewInsert(value));
  }

  async saveTaskReviewRun(value: TaskReviewRun, expectedVersion: number): Promise<void> {
    const changed = await this.db
      .update(schema.taskReviewRuns)
      .set({
        status: value.status,
        result: value.result,
        summary: value.summary,
        checks: value.checks,
        evidence: value.evidence,
        executorVersion: value.executor_version,
        version: value.version,
        updatedAt: value.updated_at,
        completedAt: value.completed_at,
      })
      .where(
        and(
          eq(schema.taskReviewRuns.id, value.id),
          eq(schema.taskReviewRuns.version, expectedVersion),
        ),
      )
      .returning({ version: schema.taskReviewRuns.version });
    if (changed.length === 0) await this.throwVersion(schema.taskReviewRuns, value.id);
  }

  async listTaskStatusHistory(taskId: UUID): Promise<TaskStatusHistory[]> {
    const rows = await this.db
      .select()
      .from(schema.taskStatusHistory)
      .where(eq(schema.taskStatusHistory.taskId, taskId))
      .orderBy(asc(schema.taskStatusHistory.createdAt));
    return rows.map(mapHistory);
  }

  async addTaskStatusHistory(value: TaskStatusHistory): Promise<void> {
    await this.db.insert(schema.taskStatusHistory).values({
      id: value.id,
      taskId: value.task_id,
      fromStatus: value.from_status,
      toStatus: value.to_status,
      actorUserId: value.actor_user_id,
      reason: value.reason,
      createdAt: value.created_at,
    });
  }

  async createAutomationOperation(value: AutomationOperation): Promise<void> {
    const tenantId = await this.tenantForUser(value.actor_user_id);
    await this.db.insert(schema.automationOperations).values(operationInsert(tenantId, value));
  }

  async getAutomationOperation(
    tenantId: UUID,
    operationId: UUID,
  ): Promise<AutomationOperation | null> {
    const [row] = await this.db
      .select()
      .from(schema.automationOperations)
      .where(
        and(
          eq(schema.automationOperations.tenantId, tenantId),
          eq(schema.automationOperations.id, operationId),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapOperation(row);
  }

  async saveAutomationOperation(
    value: AutomationOperation,
    expectedVersion: number,
  ): Promise<void> {
    const changed = await this.db
      .update(schema.automationOperations)
      .set({
        status: value.status,
        result: value.result,
        error: value.error,
        version: value.version,
        updatedAt: value.updated_at,
        completedAt: value.completed_at,
      })
      .where(
        and(
          eq(schema.automationOperations.id, value.id),
          eq(schema.automationOperations.version, expectedVersion),
        ),
      )
      .returning({ version: schema.automationOperations.version });
    if (changed.length === 0) await this.throwVersion(schema.automationOperations, value.id);
  }

  async listDailyReports(tenantId: UUID): Promise<DailyReport[]> {
    const rows = await this.db
      .select()
      .from(schema.dailyReports)
      .where(eq(schema.dailyReports.tenantId, tenantId))
      .orderBy(desc(schema.dailyReports.workDate), asc(schema.dailyReports.userId));
    return rows.map(mapReport);
  }

  async getDailyReport(
    tenantId: UUID,
    userId: UUID,
    workDate: string,
  ): Promise<DailyReport | null> {
    const [row] = await this.db
      .select()
      .from(schema.dailyReports)
      .where(
        and(
          eq(schema.dailyReports.tenantId, tenantId),
          eq(schema.dailyReports.userId, userId),
          eq(schema.dailyReports.workDate, workDate),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapReport(row);
  }

  async getDailyReportById(tenantId: UUID, reportId: UUID): Promise<DailyReport | null> {
    const [row] = await this.db
      .select()
      .from(schema.dailyReports)
      .where(and(eq(schema.dailyReports.tenantId, tenantId), eq(schema.dailyReports.id, reportId)))
      .limit(1);
    return row === undefined ? null : mapReport(row);
  }

  async createDailyReport(value: DailyReport): Promise<void> {
    await this.db.insert(schema.dailyReports).values(reportInsert(value));
  }

  async saveDailyReport(value: DailyReport, expectedVersion: number): Promise<void> {
    const changed = await this.db
      .update(schema.dailyReports)
      .set({
        departmentId: value.department_id,
        content: value.content,
        status: value.status,
        publishedAt: value.published_at,
        deletedAt: value.deleted_at,
        version: value.version,
        updatedAt: value.updated_at,
      })
      .where(
        and(eq(schema.dailyReports.id, value.id), eq(schema.dailyReports.version, expectedVersion)),
      )
      .returning({ version: schema.dailyReports.version });
    if (changed.length === 0) await this.throwVersion(schema.dailyReports, value.id);
  }

  async addDailyReportRevision(value: DailyReportRevision): Promise<void> {
    await this.db.insert(schema.dailyReportRevisions).values({
      id: value.id,
      reportId: value.report_id,
      editorUserId: value.editor_user_id,
      source: value.source,
      beforeContent: value.before_content,
      afterContent: value.after_content,
      createdAt: value.created_at,
    });
  }

  async listDailyReportRevisions(reportId: UUID): Promise<DailyReportRevision[]> {
    const rows = await this.db
      .select()
      .from(schema.dailyReportRevisions)
      .where(eq(schema.dailyReportRevisions.reportId, reportId))
      .orderBy(asc(schema.dailyReportRevisions.createdAt));
    return rows.map((row) => ({
      id: row.id,
      report_id: row.reportId,
      editor_user_id: row.editorUserId,
      source: row.source as DailyReportRevision['source'],
      before_content: row.beforeContent,
      after_content: row.afterContent,
      created_at: timestamp(row.createdAt),
    }));
  }

  async getDepartment(tenantId: UUID, departmentId: UUID): Promise<Department | null> {
    const [row] = await this.db
      .select()
      .from(schema.platformDepartments)
      .where(
        and(
          eq(schema.platformDepartments.tenantId, tenantId),
          eq(schema.platformDepartments.id, departmentId),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          status: row.status as Department['status'],
          version: row.version,
        };
  }

  async listDepartmentUsers(tenantId: UUID, departmentId: UUID): Promise<UserSummary[]> {
    const rows = await this.db
      .select({ user: schema.platformUsers })
      .from(schema.platformUsers)
      .innerJoin(
        schema.platformDepartmentMembers,
        eq(schema.platformUsers.id, schema.platformDepartmentMembers.userId),
      )
      .where(
        and(
          eq(schema.platformUsers.tenantId, tenantId),
          eq(schema.platformUsers.status, 'active'),
          eq(schema.platformDepartmentMembers.departmentId, departmentId),
        ),
      )
      .orderBy(asc(schema.platformUsers.id));
    return rows.map(({ user }) => mapUser(user));
  }

  async getUser(tenantId: UUID, userId: UUID): Promise<UserSummary | null> {
    const [row] = await this.db
      .select()
      .from(schema.platformUsers)
      .where(and(eq(schema.platformUsers.tenantId, tenantId), eq(schema.platformUsers.id, userId)))
      .limit(1);
    return row === undefined ? null : mapUser(row);
  }

  async getIdempotencyRecord(
    tenantId: UUID,
    actorUserId: UUID,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.idempotencyRecords)
      .where(
        and(
          eq(schema.idempotencyRecords.tenantId, tenantId),
          eq(schema.idempotencyRecords.actorUserId, actorUserId),
          eq(schema.idempotencyRecords.route, route),
          eq(schema.idempotencyRecords.key, key),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          tenant_id: row.tenantId,
          actor_user_id: row.actorUserId,
          route: row.route,
          key: row.key,
          request_hash: row.requestHash,
          status_code: row.statusCode,
          response_json: row.responseJson,
          expires_at: row.expiresAt,
        };
  }

  async putIdempotencyRecord(value: IdempotencyRecord): Promise<void> {
    await this.db
      .insert(schema.idempotencyRecords)
      .values({
        tenantId: value.tenant_id,
        actorUserId: value.actor_user_id,
        route: value.route,
        key: value.key,
        requestHash: value.request_hash,
        statusCode: value.status_code,
        responseJson: value.response_json,
        expiresAt: value.expires_at,
      })
      .onConflictDoUpdate({
        target: [
          schema.idempotencyRecords.tenantId,
          schema.idempotencyRecords.actorUserId,
          schema.idempotencyRecords.route,
          schema.idempotencyRecords.key,
        ],
        set: {
          requestHash: value.request_hash,
          statusCode: value.status_code,
          responseJson: value.response_json,
          expiresAt: value.expires_at,
        },
      });
  }

  async addAuditEvent(value: AuditEvent): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      id: value.id,
      tenantId: value.tenant_id,
      actorUserId: value.actor_user_id,
      action: value.action,
      resourceType: value.resource_type,
      resourceId: value.resource_id,
      result: value.result,
      requestId: value.request_id,
      details: value.details,
      createdAt: value.created_at,
    });
  }

  async listAuditEvents(tenantId: UUID): Promise<AuditEvent[]> {
    const rows = await this.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.tenantId, tenantId))
      .orderBy(asc(schema.auditEvents.createdAt));
    return rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenantId,
      actor_user_id: row.actorUserId,
      action: row.action,
      resource_type: row.resourceType,
      resource_id: row.resourceId,
      result: row.result as AuditEvent['result'],
      request_id: row.requestId,
      details: row.details,
      created_at: timestamp(row.createdAt),
    }));
  }

  private async tenantForUser(userId: UUID): Promise<UUID> {
    const [row] = await this.db
      .select({ tenantId: schema.platformUsers.tenantId })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, userId))
      .limit(1);
    if (row === undefined) throw conflict('actor_not_found', 'Actor user was not found.');
    return row.tenantId;
  }

  private async throwDocumentVersion(id: UUID): Promise<never> {
    const [row] = await this.db
      .select({ version: schema.fakeKnowledgeDocuments.version })
      .from(schema.fakeKnowledgeDocuments)
      .where(eq(schema.fakeKnowledgeDocuments.id, id))
      .limit(1);
    throw row === undefined
      ? conflict('document_missing', 'Knowledge document is missing.')
      : versionConflict(row.version);
  }

  private async throwVersion(
    table:
      | typeof schema.requirements
      | typeof schema.tasks
      | typeof schema.fakeKnowledgeUploads
      | typeof schema.taskReviewRuns
      | typeof schema.automationOperations
      | typeof schema.dailyReports,
    id: UUID,
  ): Promise<never> {
    const [row] = await this.db
      .select({ version: table.version })
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    throw row === undefined
      ? conflict('resource_missing', 'Resource is missing.')
      : versionConflict(row.version);
  }
}

function mapDocument(row: typeof schema.fakeKnowledgeDocuments.$inferSelect): KnowledgeDocument {
  return {
    id: row.id,
    knowledge_id: row.knowledgeId,
    scope: row.scope as KnowledgeDocument['scope'],
    owner_user_id: row.ownerUserId,
    category: row.category as KnowledgeDocument['category'],
    title: row.title,
    file_name: row.fileName,
    media_type: row.mediaType,
    size_bytes: row.sizeBytes,
    status: row.status as KnowledgeDocument['status'],
    version: row.version,
    updated_at: timestamp(row.updatedAt),
  };
}

function mapUploadInsert(tenantId: UUID, value: KnowledgeUpload) {
  return {
    id: value.id,
    tenantId,
    documentId: value.document_id,
    ownerUserId: value.owner_user_id,
    status: value.status,
    progress: value.progress,
    errorCode: value.error_code,
    scenario: value.scenario ?? 'success',
    pollCount: value.poll_count ?? 0,
    version: value.version,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function mapUpload(row: typeof schema.fakeKnowledgeUploads.$inferSelect): KnowledgeUpload {
  return {
    id: row.id,
    document_id: row.documentId,
    owner_user_id: row.ownerUserId,
    status: row.status as KnowledgeUpload['status'],
    progress: row.progress,
    error_code: row.errorCode,
    scenario: row.scenario as KnowledgeUpload['scenario'],
    poll_count: row.pollCount,
    version: row.version,
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
  };
}

function mapRequirement(row: typeof schema.requirements.$inferSelect): Requirement {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    department_id: row.departmentId,
    publisher_user_id: row.publisherUserId,
    title: row.title,
    objective: row.objective,
    acceptance_criteria: row.acceptanceCriteria,
    status: row.status as Requirement['status'],
    version: row.version,
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
    published_at: nullableTimestamp(row.publishedAt),
  };
}

function mapTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    requirement_id: row.requirementId,
    parent_task_id: row.parentTaskId,
    department_id: row.departmentId,
    assignee_user_id: row.assigneeUserId,
    title: row.title,
    description: row.description,
    acceptance_criteria: row.acceptanceCriteria,
    status: row.status as Task['status'],
    position: row.position,
    due_at: nullableTimestamp(row.dueAt),
    latest_review_result: row.latestReviewResult as Task['latest_review_result'],
    version: row.version,
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
  };
}

function mapSubmission(row: typeof schema.taskSubmissions.$inferSelect): TaskSubmission {
  return {
    id: row.id,
    task_id: row.taskId,
    submitter_user_id: row.submitterUserId,
    summary: row.summary,
    evidence: row.evidence,
    created_at: timestamp(row.createdAt),
  };
}

function reviewInsert(value: TaskReviewRun) {
  return {
    id: value.id,
    taskId: value.task_id,
    submissionId: value.submission_id,
    automationRunId: value.automation_run_id,
    status: value.status,
    result: value.result,
    summary: value.summary,
    checks: value.checks,
    evidence: value.evidence,
    executorVersion: value.executor_version,
    version: value.version,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at,
  };
}

function mapReview(row: typeof schema.taskReviewRuns.$inferSelect): TaskReviewRun {
  return {
    id: row.id,
    task_id: row.taskId,
    submission_id: row.submissionId,
    automation_run_id: row.automationRunId,
    status: row.status as TaskReviewRun['status'],
    result: row.result as TaskReviewRun['result'],
    summary: row.summary,
    checks: row.checks,
    evidence: row.evidence,
    executor_version: row.executorVersion,
    version: row.version,
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
    completed_at: nullableTimestamp(row.completedAt),
  };
}

function mapHistory(row: typeof schema.taskStatusHistory.$inferSelect): TaskStatusHistory {
  return {
    id: row.id,
    task_id: row.taskId,
    from_status: row.fromStatus as TaskStatusHistory['from_status'],
    to_status: row.toStatus as TaskStatusHistory['to_status'],
    actor_user_id: row.actorUserId,
    reason: row.reason,
    created_at: timestamp(row.createdAt),
  };
}

function operationInsert(tenantId: UUID, value: AutomationOperation) {
  return {
    id: value.id,
    tenantId,
    kind: value.kind,
    actorUserId: value.actor_user_id,
    resourceType: value.resource_type,
    resourceId: value.resource_id,
    provider: value.provider,
    providerRunId: value.provider_run_id,
    status: value.status,
    result: value.result,
    error: value.error,
    version: value.version,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at,
  };
}

function mapOperation(row: typeof schema.automationOperations.$inferSelect): AutomationOperation {
  return {
    id: row.id,
    kind: row.kind as AutomationOperation['kind'],
    actor_user_id: row.actorUserId,
    resource_type: row.resourceType as AutomationOperation['resource_type'],
    resource_id: row.resourceId,
    provider: row.provider as AutomationOperation['provider'],
    provider_run_id: row.providerRunId,
    status: row.status as AutomationOperation['status'],
    result: row.result,
    error: row.error,
    version: row.version,
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
    completed_at: nullableTimestamp(row.completedAt),
  };
}

function reportInsert(value: DailyReport) {
  return {
    id: value.id,
    tenantId: value.tenant_id,
    userId: value.user_id,
    departmentId: value.department_id,
    workDate: value.work_date,
    content: value.content,
    status: value.status,
    publishedAt: value.published_at,
    deletedAt: value.deleted_at,
    version: value.version,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function mapReport(row: typeof schema.dailyReports.$inferSelect): DailyReport {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    user_id: row.userId,
    department_id: row.departmentId,
    work_date: row.workDate,
    content: row.content,
    status: row.status as DailyReport['status'],
    version: row.version,
    published_at: nullableTimestamp(row.publishedAt),
    deleted_at: nullableTimestamp(row.deletedAt),
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
  };
}

function mapUser(row: typeof schema.platformUsers.$inferSelect): UserSummary {
  return {
    id: row.id,
    username: row.username,
    display_name: row.displayName,
    platform_role: row.platformRole as UserSummary['platform_role'],
  };
}

function timestamp(value: string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: string | null): string | null {
  return value === null ? null : timestamp(value);
}
