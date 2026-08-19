import type {
  AutomationOperation,
  DailyReport,
  KnowledgeUpload,
  Requirement,
  Task,
  TaskReviewRun,
} from '../domain/models.js';
import type { RequirementDetail, TaskDetail } from '../application/task-service.js';

export function presentRequirement(requirement: Requirement) {
  const { tenant_id: _tenantId, ...result } = requirement;
  return result;
}

export function presentTaskSummary(task: Task) {
  const {
    department_id: _departmentId,
    description: _description,
    acceptance_criteria: _criteria,
    created_at: _createdAt,
    ...result
  } = task;
  return result;
}

export function presentReviewRun(review: TaskReviewRun) {
  const {
    automation_run_id: _operationId,
    version: _version,
    updated_at: _updatedAt,
    ...result
  } = review;
  return result;
}

export function presentTaskDetail(task: TaskDetail) {
  return {
    ...presentTaskSummary(task),
    description: task.description,
    acceptance_criteria: task.acceptance_criteria,
    dependencies: task.dependencies,
    submissions: task.submissions,
    review_runs: task.review_runs.map(presentReviewRun),
  };
}

export function presentRequirementDetail(requirement: RequirementDetail) {
  return {
    ...presentRequirement(requirement),
    tasks: requirement.tasks.map(presentTaskSummary),
  };
}

export function presentAutomation(operation: AutomationOperation) {
  const {
    actor_user_id: _actor,
    resource_type: _resourceType,
    resource_id: _resourceId,
    provider: _provider,
    provider_run_id: _providerRunId,
    version: _version,
    poll_count: _pollCount,
    updated_at: _updatedAt,
    ...result
  } = operation;
  return result;
}

export function presentDailyReport(report: DailyReport) {
  const {
    tenant_id: _tenantId,
    deleted_at: _deletedAt,
    created_at: _createdAt,
    ...result
  } = report;
  return result;
}

export function presentKnowledgeUpload(upload: KnowledgeUpload) {
  const {
    owner_user_id: _owner,
    version: _version,
    scenario: _scenario,
    poll_count: _pollCount,
    ...result
  } = upload;
  return result;
}
