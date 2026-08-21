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
} from '../domain/models.js';

export interface NewKnowledgeUpload {
  upload: KnowledgeUpload;
  document: KnowledgeDocument;
}

export interface NewRequirement {
  requirement: Requirement;
}

export interface BusinessRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  withIdempotencyLock<T>(scope: string, work: () => Promise<T>): Promise<T>;

  listKnowledgeCategories(scope: KnowledgeScope): Promise<KnowledgeCategory[]>;
  listKnowledgeDocuments(tenantId: UUID): Promise<KnowledgeDocument[]>;
  getKnowledgeDocument(tenantId: UUID, documentId: UUID): Promise<KnowledgeDocument | null>;
  createKnowledgeUpload(value: NewKnowledgeUpload): Promise<void>;
  createKnowledgeReindex(upload: KnowledgeUpload): Promise<void>;
  getKnowledgeUpload(tenantId: UUID, uploadId: UUID): Promise<KnowledgeUpload | null>;
  saveKnowledgeUpload(upload: KnowledgeUpload, expectedVersion: number): Promise<void>;
  saveKnowledgeDocument(document: KnowledgeDocument, expectedVersion: number): Promise<void>;

  listRequirements(tenantId: UUID): Promise<Requirement[]>;
  getRequirement(tenantId: UUID, requirementId: UUID): Promise<Requirement | null>;
  createRequirement(value: Requirement): Promise<void>;
  saveRequirement(value: Requirement, expectedVersion: number): Promise<void>;

  listTasks(tenantId: UUID): Promise<Task[]>;
  getTask(tenantId: UUID, taskId: UUID): Promise<Task | null>;
  createTasks(tasks: Task[], dependencies: TaskDependency[]): Promise<void>;
  saveTask(value: Task, expectedVersion: number): Promise<void>;
  listTaskDependencies(taskId: UUID): Promise<TaskDependency[]>;
  listTaskSubmissions(taskId: UUID): Promise<TaskSubmission[]>;
  addTaskSubmission(value: TaskSubmission): Promise<void>;
  listTaskReviewRuns(taskId: UUID): Promise<TaskReviewRun[]>;
  addTaskReviewRun(value: TaskReviewRun): Promise<void>;
  saveTaskReviewRun(value: TaskReviewRun, expectedVersion: number): Promise<void>;
  listTaskStatusHistory(taskId: UUID): Promise<TaskStatusHistory[]>;
  addTaskStatusHistory(value: TaskStatusHistory): Promise<void>;

  createAutomationOperation(value: AutomationOperation): Promise<void>;
  getAutomationOperation(tenantId: UUID, operationId: UUID): Promise<AutomationOperation | null>;
  saveAutomationOperation(value: AutomationOperation, expectedVersion: number): Promise<void>;

  listDailyReports(tenantId: UUID): Promise<DailyReport[]>;
  getDailyReport(tenantId: UUID, userId: UUID, workDate: string): Promise<DailyReport | null>;
  getDailyReportById(tenantId: UUID, reportId: UUID): Promise<DailyReport | null>;
  createDailyReport(value: DailyReport): Promise<void>;
  saveDailyReport(value: DailyReport, expectedVersion: number): Promise<void>;
  addDailyReportRevision(value: DailyReportRevision): Promise<void>;
  listDailyReportRevisions(reportId: UUID): Promise<DailyReportRevision[]>;

  getDepartment(tenantId: UUID, departmentId: UUID): Promise<Department | null>;
  listDepartmentUsers(tenantId: UUID, departmentId: UUID): Promise<UserSummary[]>;
  getUser(tenantId: UUID, userId: UUID): Promise<UserSummary | null>;

  getIdempotencyRecord(
    tenantId: UUID,
    actorUserId: UUID,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  putIdempotencyRecord(value: IdempotencyRecord): Promise<void>;
  addAuditEvent(value: AuditEvent): Promise<void>;
  listAuditEvents(tenantId: UUID): Promise<AuditEvent[]>;
}
