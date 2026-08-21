import { forbidden } from './errors.js';
import type { ActorContext, KnowledgeDocument, Requirement, Task } from './models.js';

export function requireDepartment(actor: ActorContext): string {
  if (actor.departmentId === null || actor.orgRole === null) {
    throw forbidden('A department membership is required.');
  }
  return actor.departmentId;
}

export function requireManager(actor: ActorContext, departmentId?: string): void {
  const actorDepartment = requireDepartment(actor);
  if (
    actor.orgRole !== 'manager' ||
    (departmentId !== undefined && actorDepartment !== departmentId)
  ) {
    throw forbidden('A manager relationship for this department is required.');
  }
}

export function canReadRequirement(actor: ActorContext, requirement: Requirement): boolean {
  if (
    actor.tenantId !== requirement.tenant_id ||
    actor.departmentId !== requirement.department_id
  ) {
    return false;
  }
  if (requirement.status === 'published') return true;
  return actor.orgRole === 'manager' || actor.userId === requirement.publisher_user_id;
}

export function canManageRequirement(actor: ActorContext, requirement: Requirement): boolean {
  return (
    actor.tenantId === requirement.tenant_id &&
    actor.departmentId === requirement.department_id &&
    actor.orgRole === 'manager'
  );
}

export function canReadTask(actor: ActorContext, task: Task): boolean {
  return (
    actor.departmentId === task.department_id &&
    (actor.orgRole === 'manager' || task.assignee_user_id === actor.userId)
  );
}

export function canManageTask(actor: ActorContext, task: Task): boolean {
  return actor.departmentId === task.department_id && actor.orgRole === 'manager';
}

export function canMutateKnowledge(actor: ActorContext, document: KnowledgeDocument): boolean {
  if (document.scope === 'company') return actor.platformRole === 'admin';
  return document.owner_user_id === actor.userId;
}
