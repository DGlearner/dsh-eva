import { afterEach, describe, expect, it } from 'vitest';
import { fixture, me, resetStore, taskDetail } from '../mocks/store';

afterEach(resetStore);

describe('fixture-backed mock store', () => {
  it('derives platform and organization roles from fixture-v1', () => {
    expect(me('admin')?.user.platform_role).toBe('admin');
    expect(me('dev_manager')?.department?.org_role).toBe('manager');
    expect(me('dev_a')?.department?.org_role).toBe('member');
  });

  it('keeps personal knowledge ownership distinct', () => {
    const personalOwners = new Set(
      fixture.knowledge.documents
        .filter((item) => item.scope === 'personal')
        .map((item) => item.owner_user_id),
    );
    expect(personalOwners.has(me('dev_a')?.user.id ?? '')).toBe(true);
    expect(personalOwners.has(me('dev_b')?.user.id ?? '')).toBe(true);
  });

  it('builds task detail only from fixture relationships', () => {
    const task = taskDetail('00000000-0000-4000-8000-000000004001');
    expect(task?.submissions).toHaveLength(1);
    expect(task?.review_runs[0]?.result).toBe('pass');
  });
});
