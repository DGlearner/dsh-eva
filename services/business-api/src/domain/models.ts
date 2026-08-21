export type UUID = string;
export type Timestamp = string;
export type DateString = string;

export type PlatformRole = 'admin' | 'member';
export type OrgRole = 'manager' | 'member';

export interface ActorContext {
  issuer: string;
  tenantId: UUID;
  userId: UUID;
  sessionId: UUID;
  platformRole: PlatformRole;
  departmentId: UUID | null;
  orgRole: OrgRole | null;
  requestId: string;
}

export interface UserSummary {
  id: UUID;
  username: string;
  display_name: string;
  platform_role: PlatformRole;
}

export interface Department {
  id: UUID;
  name: string;
  status: 'active' | 'disabled';
  version: number;
}

export type KnowledgeScope = 'company' | 'personal';
export type KnowledgeCategoryCode = 'company-information' | 'xiaopai-design' | 'patent-document';
export type KnowledgeDocumentStatus =
  'pending_review' | 'ready' | 'rejected' | 'archived' | 'pending_purge' | 'purging';
export type KnowledgeUploadStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface KnowledgeCategory {
  code: KnowledgeCategoryCode | null;
  name: string;
  scope: KnowledgeScope;
}

export interface KnowledgeDocument {
  id: UUID;
  knowledge_id: string;
  scope: KnowledgeScope;
  owner_user_id: UUID | null;
  category: KnowledgeCategoryCode | null;
  title: string;
  file_name: string;
  media_type: string;
  size_bytes: number;
  status: KnowledgeDocumentStatus;
  version: number;
  updated_at: Timestamp;
}

export interface KnowledgeChunk {
  document_id: UUID;
  heading_path: string[];
  content: string;
  line_start: number;
  line_end: number;
  score: number;
  vector_score: number | null;
  lexical_score: number | null;
}

export interface KnowledgeUpload {
  id: UUID;
  document_id: UUID;
  owner_user_id: UUID;
  status: KnowledgeUploadStatus;
  progress: number;
  error_code: string | null;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  scenario?: 'success' | 'fail';
  poll_count?: number;
}

export type RequirementStatus = 'draft' | 'published' | 'cancelled';
export type TaskStatus =
  'planning' | 'todo' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled';
export type ReviewResult = 'pass' | 'fail' | 'needs_review';
export type AutomationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationKind = 'requirement_split' | 'task_review' | 'daily_rewrite';

export interface Requirement {
  id: UUID;
  tenant_id: UUID;
  department_id: UUID;
  publisher_user_id: UUID;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  status: RequirementStatus;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
}

export interface Task {
  id: UUID;
  requirement_id: UUID;
  parent_task_id: UUID | null;
  department_id: UUID;
  assignee_user_id: UUID | null;
  title: string;
  description: string;
  acceptance_criteria: string[];
  status: TaskStatus;
  position: number;
  due_at: Timestamp | null;
  latest_review_result: ReviewResult | null;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskDependency {
  task_id: UUID;
  depends_on_task_id: UUID;
}

export interface EvidenceItem {
  kind: 'url' | 'text' | 'file_ref';
  label: string;
  value: string;
}

export interface TaskSubmission {
  id: UUID;
  task_id: UUID;
  submitter_user_id: UUID;
  summary: string;
  evidence: EvidenceItem[];
  created_at: Timestamp;
}

export interface TaskStatusHistory {
  id: UUID;
  task_id: UUID;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  actor_user_id: UUID;
  reason: string | null;
  created_at: Timestamp;
}

export interface ReviewCheck {
  name: string;
  passed: boolean | null;
  detail: string;
}

export interface TaskReviewRun {
  id: UUID;
  task_id: UUID;
  submission_id: UUID;
  automation_run_id: UUID;
  status: AutomationRunStatus;
  result: ReviewResult | null;
  summary: string | null;
  checks: ReviewCheck[];
  evidence: EvidenceItem[];
  executor_version: string;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface SplitTaskDraft {
  client_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  assignee_user_id: UUID | null;
  depends_on_client_ids: string[];
  position: number;
}

export interface RequirementSplitResult {
  tasks: SplitTaskDraft[];
}

export interface TaskReviewAutomationResult {
  result: ReviewResult;
  summary: string;
  checks: ReviewCheck[];
  evidence: EvidenceItem[];
  executor_version: string;
}

export interface DailyReportContent {
  completed_today: string;
  next_plan: string;
  blockers: string;
  other: string;
  free_text: string | null;
}

export interface DailyRewriteResult {
  content: DailyReportContent;
}

export type AutomationResult =
  RequirementSplitResult | TaskReviewAutomationResult | DailyRewriteResult;

export interface AutomationOperation {
  id: UUID;
  kind: AutomationKind;
  actor_user_id: UUID;
  resource_type: 'requirement' | 'task' | 'daily_report';
  resource_id: UUID;
  provider: 'fake' | 'dsh';
  provider_run_id: UUID | null;
  status: AutomationRunStatus;
  result: AutomationResult | null;
  error: { code: string; message: string } | null;
  version: number;
  poll_count?: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export type DailyReportStatus = 'draft' | 'published' | 'deleted';

export interface DailyReport {
  id: UUID;
  tenant_id: UUID;
  user_id: UUID;
  department_id: UUID;
  work_date: DateString;
  content: DailyReportContent;
  status: DailyReportStatus;
  version: number;
  published_at: Timestamp | null;
  deleted_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DailyReportRevision {
  id: UUID;
  report_id: UUID;
  editor_user_id: UUID;
  source: 'manual' | 'ai_rewrite' | 'reopen';
  before_content: DailyReportContent | null;
  after_content: DailyReportContent;
  created_at: Timestamp;
}

export interface AuditEvent {
  id: UUID;
  tenant_id: UUID;
  actor_user_id: UUID;
  action: string;
  resource_type: string;
  resource_id: string;
  result: 'success' | 'denied' | 'failed';
  request_id: string;
  details: Record<string, unknown>;
  created_at: Timestamp;
}

export interface IdempotencyRecord {
  tenant_id: UUID;
  actor_user_id: UUID;
  route: string;
  key: string;
  request_hash: string;
  status_code: number;
  response_json: unknown;
  expires_at: Timestamp;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
