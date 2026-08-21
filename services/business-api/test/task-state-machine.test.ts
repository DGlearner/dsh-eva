import { describe, expect, it } from 'vitest';

import { assertTaskTransition, canTaskTransition } from '../src/domain/task-state-machine.js';

describe('task state machine', () => {
  it.each([
    ['planning', 'todo'],
    ['todo', 'in_progress'],
    ['in_progress', 'review'],
    ['review', 'done'],
    ['in_progress', 'failed'],
    ['failed', 'in_progress'],
    ['review', 'in_progress'],
    ['planning', 'cancelled'],
    ['todo', 'cancelled'],
    ['in_progress', 'cancelled'],
    ['review', 'cancelled'],
    ['failed', 'cancelled'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTaskTransition(from, to)).toBe(true);
  });

  it('rejects automatic or backward completion shortcuts', () => {
    expect(() => assertTaskTransition('in_progress', 'done')).toThrow(/cannot transition/);
    expect(() => assertTaskTransition('done', 'in_progress')).toThrow(/cannot transition/);
    expect(() => assertTaskTransition('cancelled', 'todo')).toThrow(/cannot transition/);
  });
});
