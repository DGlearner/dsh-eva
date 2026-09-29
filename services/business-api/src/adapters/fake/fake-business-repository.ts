import { AsyncLocalStorage } from 'node:async_hooks';

import fixtureJson from '@company/test-fixtures/fixture-v1' with { type: 'json' };

import { conflict, versionConflict } from '../../domain/errors.js';
import type {
  AuditEvent,
  AutomationOperation,
  DailyReport,
  DailyReportRevision,
  DailyReportScope,
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

interface FixtureUser extends UserSummary {
  status: string;
}

interface FixtureMembership {
  department_id: UUID;
  user_id: UUID;
  org_role: 'manager' | 'member';
  version: number;
}

interface FixtureDocument extends KnowledgeDocument {
  fixture_key: string;
}

interface FixtureData {
  tenant: { id: UUID };
  departments: Department[];
  users: FixtureUser[];
  department_members: FixtureMembership[];
  knowledge: {
    categories: KnowledgeCategory[];
    documents: FixtureDocument[];
    uploads: Array<Omit<KnowledgeUpload, 'version'>>;
  };
  requirements: Array<Omit<Requirement, 'tenant_id'>>;
  tasks: Array<Omit<Task, 'created_at'>>;
  task_dependencies: TaskDependency[];
  task_submissions: TaskSubmission[];
  task_review_runs: Array<Omit<TaskReviewRun, 'version' | 'updated_at'>>;
  automation_operations: Array<
    Omit<AutomationOperation, 'provider_run_id' | 'version' | 'updated_at'>
  >;
  daily_reports: Array<Omit<DailyReport, 'tenant_id' | 'deleted_at' | 'created_at'>>;
  daily_report_revisions: DailyReportRevision[];
}

const fixture = fixtureJson as unknown as FixtureData;

const clone = <T>(value: T): T => structuredClone(value);

export type FakeRepositoryFailurePoint =
  | 'createKnowledgeUpload'
  | 'createKnowledgeReindex'
  | 'saveKnowledgeUpload'
  | 'saveKnowledgeDocument'
  | 'createRequirement'
  | 'saveRequirement'
  | 'createTasks'
  | 'saveTask'
  | 'addTaskSubmission'
  | 'addTaskReviewRun'
  | 'saveTaskReviewRun'
  | 'addTaskStatusHistory'
  | 'createAutomationOperation'
  | 'saveAutomationOperation'
  | 'createDailyReport'
  | 'saveDailyReport'
  | 'addDailyReportRevision'
  | 'putIdempotencyRecord'
  | 'addAuditEvent';

interface FakeRepositoryState {
  documents: Array<[UUID, KnowledgeDocument]>;
  uploads: Array<[UUID, KnowledgeUpload]>;
  requirements: Array<[UUID, Requirement]>;
  tasks: Array<[UUID, Task]>;
  dependencies: TaskDependency[];
  submissions: Array<[UUID, TaskSubmission]>;
  reviews: Array<[UUID, TaskReviewRun]>;
  histories: Array<[UUID, TaskStatusHistory]>;
  operations: Array<[UUID, AutomationOperation]>;
  reports: Array<[UUID, DailyReport]>;
  revisions: Array<[UUID, DailyReportRevision]>;
  idempotency: Array<[string, IdempotencyRecord]>;
  audits: Array<[UUID, AuditEvent]>;
}

export class FakeBusinessRepository implements BusinessRepository {
  private readonly tenantId = fixture.tenant.id;
  private readonly categories = clone(fixture.knowledge.categories);
  private readonly documents = new Map<UUID, KnowledgeDocument>();
  private readonly uploads = new Map<UUID, KnowledgeUpload>();
  private readonly requirements = new Map<UUID, Requirement>();
  private readonly tasks = new Map<UUID, Task>();
  private readonly dependencies: TaskDependency[] = clone(fixture.task_dependencies);
  private readonly submissions = new Map<UUID, TaskSubmission>();
  private readonly reviews = new Map<UUID, TaskReviewRun>();
  private readonly histories = new Map<UUID, TaskStatusHistory>();
  private readonly operations = new Map<UUID, AutomationOperation>();
  private readonly reports = new Map<UUID, DailyReport>();
  private readonly revisions = new Map<UUID, DailyReportRevision>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private readonly audits = new Map<UUID, AuditEvent>();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private readonly failures = new Map<FakeRepositoryFailurePoint, Error[]>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor() {
    for (const document of fixture.knowledge.documents) {
      const { fixture_key: _fixtureKey, ...publicDocument } = document;
      this.documents.set(document.id, clone(publicDocument));
    }
    for (const upload of fixture.knowledge.uploads) {
      this.uploads.set(upload.id, { ...clone(upload), version: 1, poll_count: 3 });
    }
    for (const requirement of fixture.requirements) {
      this.requirements.set(requirement.id, { ...clone(requirement), tenant_id: this.tenantId });
    }
    for (const task of fixture.tasks) {
      this.tasks.set(task.id, { ...clone(task), created_at: task.updated_at });
    }
    for (const submission of fixture.task_submissions) {
      this.submissions.set(submission.id, clone(submission));
    }
    for (const review of fixture.task_review_runs) {
      this.reviews.set(review.id, {
        ...clone(review),
        version: 1,
        updated_at: review.completed_at ?? review.created_at,
      });
    }
    for (const operation of fixture.automation_operations) {
      this.operations.set(operation.id, {
        ...clone(operation),
        provider_run_id: operation.id,
        version: 1,
        poll_count: 2,
        updated_at: operation.completed_at ?? operation.created_at,
      });
    }
    for (const report of fixture.daily_reports) {
      this.reports.set(report.id, {
        ...clone(report),
        tenant_id: this.tenantId,
        deleted_at: null,
        created_at: report.updated_at,
      });
    }
    for (const revision of fixture.daily_report_revisions) {
      this.revisions.set(revision.id, clone(revision));
    }
  }

  async healthCheck(): Promise<void> {}

  async close(): Promise<void> {}

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() === true) return work();

    const previous = this.transactionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transactionTail = current;
    await previous;

    const snapshot = this.snapshot();
    try {
      return await this.transactionContext.run(true, work);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      release();
      if (this.transactionTail === current) this.transactionTail = Promise.resolve();
    }
  }

  failNext(point: FakeRepositoryFailurePoint, error?: Error): void {
    const failures = this.failures.get(point) ?? [];
    failures.push(error ?? new Error(`Injected repository failure at ${point}.`));
    this.failures.set(point, failures);
  }

  async withIdempotencyLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = this.idempotencyLocks.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.idempotencyLocks.set(scope, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.idempotencyLocks.get(scope) === current) this.idempotencyLocks.delete(scope);
    }
  }

  async listKnowledgeCategories(scope: KnowledgeScope): Promise<KnowledgeCategory[]> {
    if (scope === 'personal') return [];
    return clone(this.categories.filter((category) => category.scope === scope));
  }

  async listKnowledgeDocuments(tenantId: UUID): Promise<KnowledgeDocument[]> {
    this.assertTenant(tenantId);
    return clone([...this.documents.values()]);
  }

  async getKnowledgeDocument(tenantId: UUID, documentId: UUID): Promise<KnowledgeDocument | null> {
    this.assertTenant(tenantId);
    return clone(this.documents.get(documentId) ?? null);
  }

  async createKnowledgeUpload(value: NewKnowledgeUpload): Promise<void> {
    this.maybeFail('createKnowledgeUpload');
    if (this.documents.has(value.document.id) || this.uploads.has(value.upload.id)) {
      throw conflict('knowledge_upload_conflict', 'Knowledge upload already exists.');
    }
    this.documents.set(value.document.id, clone(value.document));
    this.uploads.set(value.upload.id, clone(value.upload));
  }

  async createKnowledgeReindex(upload: KnowledgeUpload): Promise<void> {
    this.maybeFail('createKnowledgeReindex');
    if (this.uploads.has(upload.id) || !this.documents.has(upload.document_id)) {
      throw conflict('knowledge_reindex_conflict', 'Knowledge reindex cannot be created.');
    }
    this.uploads.set(upload.id, clone(upload));
  }

  async getKnowledgeUpload(tenantId: UUID, uploadId: UUID): Promise<KnowledgeUpload | null> {
    this.assertTenant(tenantId);
    return clone(this.uploads.get(uploadId) ?? null);
  }

  async saveKnowledgeUpload(upload: KnowledgeUpload, expectedVersion: number): Promise<void> {
    this.maybeFail('saveKnowledgeUpload');
    const current = this.uploads.get(upload.id);
    if (current === undefined) throw conflict('upload_missing', 'Knowledge upload is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.uploads.set(upload.id, clone(upload));
  }

  async saveKnowledgeDocument(document: KnowledgeDocument, expectedVersion: number): Promise<void> {
    this.maybeFail('saveKnowledgeDocument');
    const current = this.documents.get(document.id);
    if (current === undefined) throw conflict('document_missing', 'Knowledge document is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.documents.set(document.id, clone(document));
  }

  async listRequirements(tenantId: UUID): Promise<Requirement[]> {
    this.assertTenant(tenantId);
    return clone([...this.requirements.values()]);
  }

  async getRequirement(tenantId: UUID, requirementId: UUID): Promise<Requirement | null> {
    this.assertTenant(tenantId);
    return clone(this.requirements.get(requirementId) ?? null);
  }

  async createRequirement(value: Requirement): Promise<void> {
    this.maybeFail('createRequirement');
    this.assertTenant(value.tenant_id);
    if (this.requirements.has(value.id)) {
      throw conflict('requirement_conflict', 'Requirement already exists.');
    }
    this.requirements.set(value.id, clone(value));
  }

  async saveRequirement(value: Requirement, expectedVersion: number): Promise<void> {
    this.maybeFail('saveRequirement');
    const current = this.requirements.get(value.id);
    if (current === undefined) throw conflict('requirement_missing', 'Requirement is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.requirements.set(value.id, clone(value));
  }

  async listTasks(tenantId: UUID): Promise<Task[]> {
    this.assertTenant(tenantId);
    return clone([...this.tasks.values()]);
  }

  async getTask(tenantId: UUID, taskId: UUID): Promise<Task | null> {
    this.assertTenant(tenantId);
    return clone(this.tasks.get(taskId) ?? null);
  }

  async createTasks(tasks: Task[], dependencies: TaskDependency[]): Promise<void> {
    this.maybeFail('createTasks');
    for (const task of tasks) {
      if (this.tasks.has(task.id)) throw conflict('task_conflict', 'Task already exists.');
    }
    for (const task of tasks) this.tasks.set(task.id, clone(task));
    this.dependencies.push(...clone(dependencies));
  }

  async saveTask(value: Task, expectedVersion: number): Promise<void> {
    this.maybeFail('saveTask');
    const current = this.tasks.get(value.id);
    if (current === undefined) throw conflict('task_missing', 'Task is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.tasks.set(value.id, clone(value));
  }

  async listTaskDependencies(taskId: UUID): Promise<TaskDependency[]> {
    return clone(this.dependencies.filter((dependency) => dependency.task_id === taskId));
  }

  async listTaskSubmissions(taskId: UUID): Promise<TaskSubmission[]> {
    return clone(
      [...this.submissions.values()].filter((submission) => submission.task_id === taskId),
    );
  }

  async addTaskSubmission(value: TaskSubmission): Promise<void> {
    this.maybeFail('addTaskSubmission');
    if (this.submissions.has(value.id)) {
      throw conflict('task_submission_conflict', 'Task submission already exists.');
    }
    this.submissions.set(value.id, clone(value));
  }

  async listTaskReviewRuns(taskId: UUID): Promise<TaskReviewRun[]> {
    return clone([...this.reviews.values()].filter((review) => review.task_id === taskId));
  }

  async addTaskReviewRun(value: TaskReviewRun): Promise<void> {
    this.maybeFail('addTaskReviewRun');
    if (this.reviews.has(value.id)) throw conflict('review_conflict', 'Review run already exists.');
    this.reviews.set(value.id, clone(value));
  }

  async saveTaskReviewRun(value: TaskReviewRun, expectedVersion: number): Promise<void> {
    this.maybeFail('saveTaskReviewRun');
    const current = this.reviews.get(value.id);
    if (current === undefined) throw conflict('review_missing', 'Review run is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.reviews.set(value.id, clone(value));
  }

  async listTaskStatusHistory(taskId: UUID): Promise<TaskStatusHistory[]> {
    return clone([...this.histories.values()].filter((history) => history.task_id === taskId));
  }

  async addTaskStatusHistory(value: TaskStatusHistory): Promise<void> {
    this.maybeFail('addTaskStatusHistory');
    this.histories.set(value.id, clone(value));
  }

  async createAutomationOperation(value: AutomationOperation): Promise<void> {
    this.maybeFail('createAutomationOperation');
    if (this.operations.has(value.id)) {
      throw conflict('automation_operation_conflict', 'Automation operation already exists.');
    }
    this.operations.set(value.id, clone(value));
  }

  async getAutomationOperation(
    tenantId: UUID,
    operationId: UUID,
  ): Promise<AutomationOperation | null> {
    this.assertTenant(tenantId);
    return clone(this.operations.get(operationId) ?? null);
  }

  async saveAutomationOperation(
    value: AutomationOperation,
    expectedVersion: number,
  ): Promise<void> {
    this.maybeFail('saveAutomationOperation');
    const current = this.operations.get(value.id);
    if (current === undefined)
      throw conflict('operation_missing', 'Automation operation is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.operations.set(value.id, clone(value));
  }

  async listDailyReports(tenantId: UUID): Promise<DailyReport[]> {
    this.assertTenant(tenantId);
    return clone([...this.reports.values()]);
  }

  async getDailyReport(
    tenantId: UUID,
    userId: UUID,
    workDate: string,
    scope: DailyReportScope,
    taskId: UUID | null,
  ): Promise<DailyReport | null> {
    this.assertTenant(tenantId);
    return clone(
      [...this.reports.values()].find(
        (report) =>
          report.user_id === userId &&
          report.work_date === workDate &&
          report.scope === scope &&
          report.task_id === taskId,
      ) ?? null,
    );
  }

  async getDailyReportById(tenantId: UUID, reportId: UUID): Promise<DailyReport | null> {
    this.assertTenant(tenantId);
    return clone(this.reports.get(reportId) ?? null);
  }

  async createDailyReport(value: DailyReport): Promise<void> {
    this.maybeFail('createDailyReport');
    this.assertTenant(value.tenant_id);
    const existing = await this.getDailyReport(
      value.tenant_id,
      value.user_id,
      value.work_date,
      value.scope,
      value.task_id,
    );
    if (existing !== null) throw conflict('daily_report_exists', 'Daily report already exists.');
    this.reports.set(value.id, clone(value));
  }

  async saveDailyReport(value: DailyReport, expectedVersion: number): Promise<void> {
    this.maybeFail('saveDailyReport');
    const current = this.reports.get(value.id);
    if (current === undefined) throw conflict('daily_report_missing', 'Daily report is missing.');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    this.reports.set(value.id, clone(value));
  }

  async addDailyReportRevision(value: DailyReportRevision): Promise<void> {
    this.maybeFail('addDailyReportRevision');
    this.revisions.set(value.id, clone(value));
  }

  async listDailyReportRevisions(reportId: UUID): Promise<DailyReportRevision[]> {
    return clone(
      [...this.revisions.values()].filter((revision) => revision.report_id === reportId),
    );
  }

  async getDepartment(tenantId: UUID, departmentId: UUID): Promise<Department | null> {
    this.assertTenant(tenantId);
    return clone(fixture.departments.find((department) => department.id === departmentId) ?? null);
  }

  async listDepartmentUsers(tenantId: UUID, departmentId: UUID): Promise<UserSummary[]> {
    this.assertTenant(tenantId);
    const userIds = new Set(
      fixture.department_members
        .filter((membership) => membership.department_id === departmentId)
        .map((membership) => membership.user_id),
    );
    return clone(
      fixture.users
        .filter((user) => userIds.has(user.id) && user.status === 'active')
        .map(({ status: _status, ...user }) => user),
    );
  }

  async getUser(tenantId: UUID, userId: UUID): Promise<UserSummary | null> {
    this.assertTenant(tenantId);
    const found = fixture.users.find((user) => user.id === userId);
    if (found === undefined) return null;
    const { status: _status, ...user } = found;
    return clone(user);
  }

  async getIdempotencyRecord(
    tenantId: UUID,
    actorUserId: UUID,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const record = this.idempotency.get(this.idempotencyKey(tenantId, actorUserId, route, key));
    return clone(record ?? null);
  }

  async putIdempotencyRecord(value: IdempotencyRecord): Promise<void> {
    this.maybeFail('putIdempotencyRecord');
    const key = this.idempotencyKey(value.tenant_id, value.actor_user_id, value.route, value.key);
    this.idempotency.set(key, clone(value));
  }

  async addAuditEvent(value: AuditEvent): Promise<void> {
    this.maybeFail('addAuditEvent');
    this.audits.set(value.id, clone(value));
  }

  async listAuditEvents(tenantId: UUID): Promise<AuditEvent[]> {
    this.assertTenant(tenantId);
    return clone([...this.audits.values()]);
  }

  private assertTenant(tenantId: UUID): void {
    if (tenantId !== this.tenantId) throw conflict('tenant_not_seeded', 'Tenant is not seeded.');
  }

  private idempotencyKey(tenantId: UUID, actorUserId: UUID, route: string, key: string): string {
    return `${tenantId}:${actorUserId}:${route}:${key}`;
  }

  private maybeFail(point: FakeRepositoryFailurePoint): void {
    const failures = this.failures.get(point);
    const error = failures?.shift();
    if (failures?.length === 0) this.failures.delete(point);
    if (error !== undefined) throw error;
  }

  private snapshot(): FakeRepositoryState {
    return clone({
      documents: [...this.documents],
      uploads: [...this.uploads],
      requirements: [...this.requirements],
      tasks: [...this.tasks],
      dependencies: this.dependencies,
      submissions: [...this.submissions],
      reviews: [...this.reviews],
      histories: [...this.histories],
      operations: [...this.operations],
      reports: [...this.reports],
      revisions: [...this.revisions],
      idempotency: [...this.idempotency],
      audits: [...this.audits],
    });
  }

  private restore(state: FakeRepositoryState): void {
    this.replaceMap(this.documents, state.documents);
    this.replaceMap(this.uploads, state.uploads);
    this.replaceMap(this.requirements, state.requirements);
    this.replaceMap(this.tasks, state.tasks);
    this.dependencies.splice(0, this.dependencies.length, ...clone(state.dependencies));
    this.replaceMap(this.submissions, state.submissions);
    this.replaceMap(this.reviews, state.reviews);
    this.replaceMap(this.histories, state.histories);
    this.replaceMap(this.operations, state.operations);
    this.replaceMap(this.reports, state.reports);
    this.replaceMap(this.revisions, state.revisions);
    this.replaceMap(this.idempotency, state.idempotency);
    this.replaceMap(this.audits, state.audits);
  }

  private replaceMap<K, V>(target: Map<K, V>, entries: Array<[K, V]>): void {
    target.clear();
    for (const [key, value] of clone(entries)) target.set(key, value);
  }
}
