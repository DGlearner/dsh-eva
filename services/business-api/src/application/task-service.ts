import { randomUUID } from 'node:crypto';

import { conflict, forbidden, notFound, unprocessable, versionConflict } from '../domain/errors.js';
import {
  canManageRequirement,
  canManageTask,
  canReadRequirement,
  canReadTask,
  requireManager,
} from '../domain/policies.js';
import { assertTaskTransition } from '../domain/task-state-machine.js';
import type {
  ActorContext,
  AutomationKind,
  AutomationOperation,
  EvidenceItem,
  Page,
  Requirement,
  SplitTaskDraft,
  Task,
  TaskDependency,
  TaskReviewAutomationResult,
  TaskReviewRun,
  TaskStatus,
  TaskSubmission,
  UUID,
} from '../domain/models.js';
import type { AutomationPort, AutomationProviderRun } from '../ports/automation.js';
import type { Clock } from '../ports/clock.js';
import type { BusinessRepository } from '../ports/repository.js';
import { executeIdempotent, paginate, writeAudit, type IdempotentResult } from './shared.js';

export interface RequirementDetail extends Requirement {
  tasks: Task[];
}

export interface TaskDetail extends Task {
  dependencies: UUID[];
  submissions: TaskSubmission[];
  review_runs: TaskReviewRun[];
}

export class TaskService {
  constructor(
    private readonly repository: BusinessRepository,
    private readonly automation: AutomationPort,
    private readonly clock: Clock,
  ) {}

  async listRequirements(
    actor: ActorContext,
    filters: {
      view?: 'mine' | 'department';
      status?: Requirement['status'];
      cursor: string | null;
      limit: number;
    },
  ): Promise<Page<Requirement>> {
    const visible = (await this.repository.listRequirements(actor.tenantId))
      .filter((requirement) => canReadRequirement(actor, requirement))
      .filter(
        (requirement) => filters.view !== 'mine' || requirement.publisher_user_id === actor.userId,
      )
      .filter(
        (requirement) => filters.status === undefined || requirement.status === filters.status,
      )
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
      );
    return paginate(visible, filters.cursor, filters.limit);
  }

  async createRequirement(
    actor: ActorContext,
    input: Pick<Requirement, 'title' | 'objective' | 'acceptance_criteria'>,
    idempotencyKey: string,
  ): Promise<IdempotentResult<Requirement>> {
    requireManager(actor);
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: 'POST /requirements',
      key: idempotencyKey,
      request: input,
      statusCode: 201,
      execute: async () => {
        const now = this.clock.now().toISOString();
        const requirement: Requirement = {
          id: randomUUID(),
          tenant_id: actor.tenantId,
          department_id: actor.departmentId!,
          publisher_user_id: actor.userId,
          title: input.title,
          objective: input.objective,
          acceptance_criteria: input.acceptance_criteria,
          status: 'draft',
          version: 1,
          created_at: now,
          updated_at: now,
          published_at: null,
        };
        await this.repository.createRequirement(requirement);
        return requirement;
      },
    });
  }

  async getRequirement(actor: ActorContext, requirementId: UUID): Promise<RequirementDetail> {
    const requirement = await this.requirementForRead(actor, requirementId);
    return this.requirementDetail(requirement);
  }

  async updateRequirement(
    actor: ActorContext,
    requirementId: UUID,
    input: Pick<Requirement, 'title' | 'objective' | 'acceptance_criteria'> & {
      expected_version: number;
    },
  ): Promise<Requirement> {
    const requirement = await this.requirementForManage(actor, requirementId);
    if (requirement.version !== input.expected_version) throw versionConflict(requirement.version);
    if (requirement.status !== 'draft') {
      throw conflict('requirement_not_editable', 'Only draft requirements can be edited.');
    }
    const updated: Requirement = {
      ...requirement,
      title: input.title,
      objective: input.objective,
      acceptance_criteria: input.acceptance_criteria,
      version: requirement.version + 1,
      updated_at: this.clock.now().toISOString(),
    };
    await this.repository.saveRequirement(updated, requirement.version);
    return updated;
  }

  async startRequirementSplit(
    actor: ActorContext,
    requirementId: UUID,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<IdempotentResult<AutomationOperation>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /requirements/${requirementId}/split-runs`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion },
      statusCode: 202,
      execute: async () => {
        const requirement = await this.requirementForManage(actor, requirementId);
        if (requirement.version !== expectedVersion) throw versionConflict(requirement.version);
        if (requirement.status !== 'draft') {
          throw conflict('requirement_not_splittable', 'Only draft requirements can be split.');
        }
        return this.startAutomation(
          actor,
          'requirement_split',
          'requirement',
          requirement.id,
          {
            title: requirement.title,
            objective: requirement.objective,
            acceptance_criteria: requirement.acceptance_criteria,
          },
          idempotencyKey,
        );
      },
    });
  }

  async applyRequirementSplit(
    actor: ActorContext,
    requirementId: UUID,
    input: { operation_id: UUID; tasks: SplitTaskDraft[]; expected_version: number },
    idempotencyKey: string,
  ): Promise<IdempotentResult<RequirementDetail>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /requirements/${requirementId}/apply-split`,
      key: idempotencyKey,
      request: input,
      statusCode: 200,
      execute: async () => {
        const requirement = await this.requirementForManage(actor, requirementId);
        if (requirement.version !== input.expected_version)
          throw versionConflict(requirement.version);
        if (requirement.status !== 'draft') {
          throw conflict(
            'requirement_not_splittable',
            'Only draft requirements accept split tasks.',
          );
        }
        const operation = await this.repository.getAutomationOperation(
          actor.tenantId,
          input.operation_id,
        );
        if (
          operation === null ||
          operation.kind !== 'requirement_split' ||
          operation.resource_id !== requirement.id ||
          operation.status !== 'succeeded'
        ) {
          throw conflict('split_operation_not_ready', 'Split operation is not ready for apply.');
        }
        this.assertSplitGraph(input.tasks);
        const departmentUsers = new Set(
          (
            await this.repository.listDepartmentUsers(actor.tenantId, requirement.department_id)
          ).map((user) => user.id),
        );
        for (const draft of input.tasks) {
          if (draft.assignee_user_id !== null && !departmentUsers.has(draft.assignee_user_id)) {
            throw unprocessable(
              'assignee_outside_department',
              `Assignee for ${draft.client_id} is outside the requirement department.`,
            );
          }
        }
        const now = this.clock.now().toISOString();
        const ids = new Map(input.tasks.map((draft) => [draft.client_id, randomUUID()]));
        const tasks: Task[] = input.tasks.map((draft) => ({
          id: ids.get(draft.client_id)!,
          requirement_id: requirement.id,
          parent_task_id: null,
          department_id: requirement.department_id,
          assignee_user_id: draft.assignee_user_id,
          title: draft.title,
          description: draft.description,
          acceptance_criteria: draft.acceptance_criteria,
          status: 'planning',
          position: draft.position,
          due_at: null,
          latest_review_result: null,
          version: 1,
          created_at: now,
          updated_at: now,
        }));
        const dependencies: TaskDependency[] = input.tasks.flatMap((draft) =>
          draft.depends_on_client_ids.map((dependencyId) => ({
            task_id: ids.get(draft.client_id)!,
            depends_on_task_id: ids.get(dependencyId)!,
          })),
        );
        await this.repository.createTasks(tasks, dependencies);
        await this.repository.saveRequirement(
          { ...requirement, version: requirement.version + 1, updated_at: now },
          requirement.version,
        );
        return this.requirementDetail({
          ...requirement,
          version: requirement.version + 1,
          updated_at: now,
        });
      },
    });
  }

  async publishRequirement(
    actor: ActorContext,
    requirementId: UUID,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<IdempotentResult<RequirementDetail>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /requirements/${requirementId}/publish`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion },
      statusCode: 200,
      execute: async () => {
        const requirement = await this.requirementForManage(actor, requirementId);
        if (requirement.version !== expectedVersion) throw versionConflict(requirement.version);
        if (requirement.status !== 'draft') {
          throw conflict(
            'requirement_not_publishable',
            'Only draft requirements can be published.',
          );
        }
        const tasks = (await this.repository.listTasks(actor.tenantId)).filter(
          (task) => task.requirement_id === requirement.id,
        );
        if (tasks.length === 0) {
          throw unprocessable(
            'requirement_has_no_tasks',
            'At least one task is required to publish.',
          );
        }
        const now = this.clock.now().toISOString();
        for (const task of tasks) {
          if (task.status !== 'planning') continue;
          const updated = {
            ...task,
            status: 'todo' as const,
            version: task.version + 1,
            updated_at: now,
          };
          await this.repository.saveTask(updated, task.version);
          await this.addHistory(actor, task, 'todo', 'Requirement published.');
        }
        const updated: Requirement = {
          ...requirement,
          status: 'published',
          published_at: now,
          version: requirement.version + 1,
          updated_at: now,
        };
        await this.repository.saveRequirement(updated, requirement.version);
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: 'requirement.published',
          resourceType: 'requirement',
          resourceId: requirement.id,
        });
        return this.requirementDetail(updated);
      },
    });
  }

  async cancelRequirement(
    actor: ActorContext,
    requirementId: UUID,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<IdempotentResult<Requirement>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /requirements/${requirementId}/cancel`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion, reason },
      statusCode: 200,
      execute: async () => {
        const requirement = await this.requirementForManage(actor, requirementId);
        if (requirement.version !== expectedVersion) throw versionConflict(requirement.version);
        if (requirement.status === 'cancelled') return requirement;
        const now = this.clock.now().toISOString();
        const updated = {
          ...requirement,
          status: 'cancelled' as const,
          version: requirement.version + 1,
          updated_at: now,
        };
        await this.repository.saveRequirement(updated, requirement.version);
        for (const task of await this.repository.listTasks(actor.tenantId)) {
          if (
            task.requirement_id !== requirement.id ||
            task.status === 'done' ||
            task.status === 'cancelled'
          ) {
            continue;
          }
          assertTaskTransition(task.status, 'cancelled');
          await this.repository.saveTask(
            { ...task, status: 'cancelled', version: task.version + 1, updated_at: now },
            task.version,
          );
          await this.addHistory(actor, task, 'cancelled', reason);
        }
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: 'requirement.cancelled',
          resourceType: 'requirement',
          resourceId: requirement.id,
          details: { reason },
        });
        return updated;
      },
    });
  }

  async listTasks(
    actor: ActorContext,
    filters: {
      view?: 'published_by_me' | 'assigned_to_me' | 'incomplete' | 'completed';
      requirement_id?: UUID;
      assignee_user_id?: UUID;
      status?: TaskStatus;
      from?: string;
      to?: string;
      cursor: string | null;
      limit: number;
    },
  ): Promise<Page<Task>> {
    if (
      filters.assignee_user_id !== undefined &&
      filters.assignee_user_id !== actor.userId &&
      actor.orgRole !== 'manager'
    ) {
      throw forbidden('Members cannot query another assignee.');
    }
    const requirements = new Map(
      (await this.repository.listRequirements(actor.tenantId)).map((item) => [item.id, item]),
    );
    const visible = (await this.repository.listTasks(actor.tenantId))
      .filter((task) => canReadTask(actor, task))
      .filter(
        (task) =>
          filters.requirement_id === undefined || task.requirement_id === filters.requirement_id,
      )
      .filter(
        (task) =>
          filters.assignee_user_id === undefined ||
          task.assignee_user_id === filters.assignee_user_id,
      )
      .filter((task) => filters.status === undefined || task.status === filters.status)
      .filter((task) => filters.from === undefined || task.updated_at.slice(0, 10) >= filters.from)
      .filter((task) => filters.to === undefined || task.updated_at.slice(0, 10) <= filters.to)
      .filter((task) => {
        if (filters.view === undefined) return true;
        if (filters.view === 'assigned_to_me') return task.assignee_user_id === actor.userId;
        if (filters.view === 'completed') return task.status === 'done';
        if (filters.view === 'incomplete') return !['done', 'cancelled'].includes(task.status);
        return requirements.get(task.requirement_id)?.publisher_user_id === actor.userId;
      })
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
      );
    return paginate(visible, filters.cursor, filters.limit);
  }

  async getTask(actor: ActorContext, taskId: UUID): Promise<TaskDetail> {
    return this.taskDetail(await this.taskForRead(actor, taskId));
  }

  async transitionTask(
    actor: ActorContext,
    taskId: UUID,
    toStatus: TaskStatus,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<IdempotentResult<TaskDetail>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /tasks/${taskId}/transitions`,
      key: idempotencyKey,
      request: { to_status: toStatus, expected_version: expectedVersion, reason },
      statusCode: 200,
      execute: async () => {
        const task = await this.taskForRead(actor, taskId);
        if (task.version !== expectedVersion) throw versionConflict(task.version);
        if (toStatus === 'done') {
          throw conflict(
            'task_accept_endpoint_required',
            'Use the accept endpoint to complete a task.',
          );
        }
        if (actor.orgRole !== 'manager') {
          const allowedMember =
            task.assignee_user_id === actor.userId &&
            ((task.status === 'todo' && toStatus === 'in_progress') ||
              (task.status === 'failed' && toStatus === 'in_progress'));
          if (!allowedMember)
            throw forbidden('This task transition requires a department manager.');
        }
        assertTaskTransition(task.status, toStatus);
        const updated = await this.setTaskStatus(actor, task, toStatus, reason);
        return this.taskDetail(updated);
      },
    });
  }

  async createSubmission(
    actor: ActorContext,
    taskId: UUID,
    input: { summary: string; evidence: EvidenceItem[]; expected_version: number },
    idempotencyKey: string,
  ): Promise<IdempotentResult<TaskSubmission>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /tasks/${taskId}/submissions`,
      key: idempotencyKey,
      request: input,
      statusCode: 201,
      execute: async () => {
        const task = await this.taskForRead(actor, taskId);
        if (task.assignee_user_id !== actor.userId)
          throw forbidden('Only the assignee can submit.');
        if (task.version !== input.expected_version) throw versionConflict(task.version);
        if (task.status !== 'in_progress') {
          throw conflict('task_not_submittable', 'Only in-progress tasks can be submitted.');
        }
        const submission: TaskSubmission = {
          id: randomUUID(),
          task_id: task.id,
          submitter_user_id: actor.userId,
          summary: input.summary,
          evidence: input.evidence,
          created_at: this.clock.now().toISOString(),
        };
        await this.repository.addTaskSubmission(submission);
        await this.setTaskStatus(actor, task, 'review', 'Evidence submitted.');
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: 'task.submitted',
          resourceType: 'task',
          resourceId: task.id,
          details: { submission_id: submission.id },
        });
        return submission;
      },
    });
  }

  async startTaskReview(
    actor: ActorContext,
    taskId: UUID,
    input: { submission_id: UUID; expected_version: number },
    idempotencyKey: string,
  ): Promise<IdempotentResult<AutomationOperation>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /tasks/${taskId}/review-runs`,
      key: idempotencyKey,
      request: input,
      statusCode: 202,
      execute: async () => {
        const task = await this.taskForManage(actor, taskId);
        if (task.version !== input.expected_version) throw versionConflict(task.version);
        if (task.status !== 'review') {
          throw conflict('task_not_reviewable', 'Task must be in review status.');
        }
        const submission = (await this.repository.listTaskSubmissions(task.id)).find(
          (item) => item.id === input.submission_id,
        );
        if (submission === undefined) throw notFound('Task submission');
        const operation = await this.startAutomation(
          actor,
          'task_review',
          'task',
          task.id,
          {
            task: {
              title: task.title,
              acceptance_criteria: task.acceptance_criteria,
            },
            summary: submission.summary,
            evidence: submission.evidence,
          },
          idempotencyKey,
        );
        const now = this.clock.now().toISOString();
        await this.repository.addTaskReviewRun({
          id: randomUUID(),
          task_id: task.id,
          submission_id: submission.id,
          automation_run_id: operation.id,
          status: operation.status,
          result: null,
          summary: null,
          checks: [],
          evidence: [],
          executor_version: 'pending',
          version: 1,
          created_at: now,
          updated_at: now,
          completed_at: null,
        });
        return operation;
      },
    });
  }

  async getAutomationOperation(
    actor: ActorContext,
    operationId: UUID,
  ): Promise<AutomationOperation> {
    const initial = await this.repository.getAutomationOperation(actor.tenantId, operationId);
    if (initial === null) throw notFound('Automation operation');
    await this.assertOperationVisible(actor, initial);
    let providerRun: AutomationProviderRun | null = null;
    if (
      (initial.status === 'queued' || initial.status === 'running') &&
      initial.provider_run_id !== null
    ) {
      providerRun = await this.automation.get(
        initial.provider_run_id,
        actor.requestId,
        initial.kind,
      );
    }
    return this.repository.transaction(async () => {
      const operation = await this.repository.getAutomationOperation(actor.tenantId, operationId);
      if (operation === null) throw notFound('Automation operation');
      let current = operation;
      if (
        providerRun !== null &&
        (operation.status === 'queued' || operation.status === 'running')
      ) {
        const updated: AutomationOperation = {
          ...operation,
          status: providerRun.status,
          result: providerRun.output,
          error: providerRun.error,
          version: operation.version + 1,
          updated_at: this.clock.now().toISOString(),
          completed_at: providerRun.completedAt,
        };
        await this.repository.saveAutomationOperation(updated, operation.version);
        current = updated;
      }
      if (current.kind === 'task_review' && current.status === 'succeeded') {
        await this.applyReviewResult(current, actor.tenantId);
      }
      return current;
    });
  }

  async acceptTask(
    actor: ActorContext,
    taskId: UUID,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<IdempotentResult<TaskDetail>> {
    return this.managerTaskCommand(actor, taskId, expectedVersion, reason, idempotencyKey, 'done');
  }

  async returnTask(
    actor: ActorContext,
    taskId: UUID,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<IdempotentResult<TaskDetail>> {
    return this.managerTaskCommand(
      actor,
      taskId,
      expectedVersion,
      reason,
      idempotencyKey,
      'in_progress',
    );
  }

  private async managerTaskCommand(
    actor: ActorContext,
    taskId: UUID,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
    target: 'done' | 'in_progress',
  ): Promise<IdempotentResult<TaskDetail>> {
    const action = target === 'done' ? 'accept' : 'return';
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /tasks/${taskId}/${action}`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion, reason },
      statusCode: 200,
      execute: async () => {
        const task = await this.taskForManage(actor, taskId);
        if (task.version !== expectedVersion) throw versionConflict(task.version);
        if (task.status !== 'review') {
          throw conflict('task_not_awaiting_manager', 'Task is not awaiting manager decision.');
        }
        const updated = await this.setTaskStatus(actor, task, target, reason);
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: target === 'done' ? 'task.accepted' : 'task.returned',
          resourceType: 'task',
          resourceId: task.id,
          details: { reason },
        });
        return this.taskDetail(updated);
      },
    });
  }

  private async startAutomation(
    actor: ActorContext,
    kind: AutomationKind,
    resourceType: AutomationOperation['resource_type'],
    resourceId: UUID,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<AutomationOperation> {
    const providerRun = await this.automation.start({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      kind,
      correlationId: resourceId,
      input,
      idempotencyKey,
      requestId: actor.requestId,
    });
    const operation: AutomationOperation = {
      id: randomUUID(),
      kind,
      actor_user_id: actor.userId,
      resource_type: resourceType,
      resource_id: resourceId,
      provider: this.automation.provider,
      provider_run_id: providerRun.id,
      status: providerRun.status,
      result: providerRun.output,
      error: providerRun.error,
      version: 1,
      created_at: providerRun.createdAt,
      updated_at: providerRun.createdAt,
      completed_at: providerRun.completedAt,
    };
    await this.repository.createAutomationOperation(operation);
    return operation;
  }

  private async applyReviewResult(operation: AutomationOperation, tenantId: UUID): Promise<void> {
    const result = operation.result as TaskReviewAutomationResult | null;
    if (result === null) return;
    const review = (await this.repository.listTaskReviewRuns(operation.resource_id)).find(
      (item) => item.automation_run_id === operation.id,
    );
    if (review !== undefined && review.status !== 'succeeded') {
      await this.repository.saveTaskReviewRun(
        {
          ...review,
          status: 'succeeded',
          result: result.result,
          summary: result.summary,
          checks: result.checks,
          evidence: result.evidence,
          executor_version: result.executor_version,
          version: review.version + 1,
          updated_at: operation.updated_at,
          completed_at: operation.completed_at,
        },
        review.version,
      );
    }
    const current = await this.repository.getTask(tenantId, operation.resource_id);
    if (current !== null && current.latest_review_result !== result.result) {
      await this.repository.saveTask(
        {
          ...current,
          latest_review_result: result.result,
          version: current.version + 1,
          updated_at: operation.updated_at,
        },
        current.version,
      );
    }
  }

  private async assertOperationVisible(
    actor: ActorContext,
    operation: AutomationOperation,
  ): Promise<void> {
    if (operation.resource_type === 'requirement') {
      await this.requirementForRead(actor, operation.resource_id);
      return;
    }
    if (operation.resource_type === 'task') {
      await this.taskForRead(actor, operation.resource_id);
      return;
    }
    const report = await this.repository.getDailyReportById(actor.tenantId, operation.resource_id);
    if (report === null || report.user_id !== actor.userId) throw notFound('Automation operation');
  }

  private async setTaskStatus(
    actor: ActorContext,
    task: Task,
    target: TaskStatus,
    reason: string | null,
  ): Promise<Task> {
    assertTaskTransition(task.status, target);
    const updated: Task = {
      ...task,
      status: target,
      version: task.version + 1,
      updated_at: this.clock.now().toISOString(),
    };
    await this.repository.saveTask(updated, task.version);
    await this.addHistory(actor, task, target, reason);
    await writeAudit({
      repository: this.repository,
      clock: this.clock,
      actor,
      action: 'task.transitioned',
      resourceType: 'task',
      resourceId: task.id,
      details: { from_status: task.status, to_status: target, reason },
    });
    return updated;
  }

  private async addHistory(
    actor: ActorContext,
    task: Task,
    target: TaskStatus,
    reason: string | null,
  ): Promise<void> {
    await this.repository.addTaskStatusHistory({
      id: randomUUID(),
      task_id: task.id,
      from_status: task.status,
      to_status: target,
      actor_user_id: actor.userId,
      reason,
      created_at: this.clock.now().toISOString(),
    });
  }

  private async requirementForRead(actor: ActorContext, id: UUID): Promise<Requirement> {
    const requirement = await this.repository.getRequirement(actor.tenantId, id);
    if (requirement === null || !canReadRequirement(actor, requirement))
      throw notFound('Requirement');
    return requirement;
  }

  private async requirementForManage(actor: ActorContext, id: UUID): Promise<Requirement> {
    const requirement = await this.repository.getRequirement(actor.tenantId, id);
    if (requirement === null) throw notFound('Requirement');
    if (!canManageRequirement(actor, requirement)) throw forbidden();
    return requirement;
  }

  private async taskForRead(actor: ActorContext, id: UUID): Promise<Task> {
    const task = await this.repository.getTask(actor.tenantId, id);
    if (task === null || !canReadTask(actor, task)) throw notFound('Task');
    return task;
  }

  private async taskForManage(actor: ActorContext, id: UUID): Promise<Task> {
    const task = await this.repository.getTask(actor.tenantId, id);
    if (task === null) throw notFound('Task');
    if (!canManageTask(actor, task)) throw forbidden();
    return task;
  }

  private async requirementDetail(requirement: Requirement): Promise<RequirementDetail> {
    const tasks = (await this.repository.listTasks(requirement.tenant_id))
      .filter((task) => task.requirement_id === requirement.id)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    return { ...requirement, tasks };
  }

  private async taskDetail(task: Task): Promise<TaskDetail> {
    const [dependencies, submissions, reviewRuns] = await Promise.all([
      this.repository.listTaskDependencies(task.id),
      this.repository.listTaskSubmissions(task.id),
      this.repository.listTaskReviewRuns(task.id),
    ]);
    return {
      ...task,
      dependencies: dependencies.map((dependency) => dependency.depends_on_task_id),
      submissions: submissions.sort((left, right) =>
        left.created_at.localeCompare(right.created_at),
      ),
      review_runs: reviewRuns.sort((left, right) =>
        left.created_at.localeCompare(right.created_at),
      ),
    };
  }

  private assertSplitGraph(tasks: SplitTaskDraft[]): void {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (ids.has(task.client_id)) {
        throw unprocessable('duplicate_split_client_id', `Duplicate client_id ${task.client_id}.`);
      }
      ids.add(task.client_id);
    }
    for (const task of tasks) {
      for (const dependency of task.depends_on_client_ids) {
        if (!ids.has(dependency)) {
          throw unprocessable(
            'unknown_split_dependency',
            `Task ${task.client_id} depends on unknown ${dependency}.`,
          );
        }
        if (dependency === task.client_id) {
          throw unprocessable('self_split_dependency', 'A split task cannot depend on itself.');
        }
      }
    }
  }
}
