import { conflict } from './errors.js';
import type { TaskStatus } from './models.js';

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planning: ['todo', 'cancelled'],
  todo: ['in_progress', 'cancelled'],
  in_progress: ['review', 'failed', 'cancelled'],
  review: ['done', 'in_progress', 'failed', 'cancelled'],
  done: [],
  failed: ['in_progress', 'cancelled'],
  cancelled: [],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw conflict('invalid_task_transition', `Task cannot transition from ${from} to ${to}.`);
  }
}

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTransitions[from].includes(to);
}
