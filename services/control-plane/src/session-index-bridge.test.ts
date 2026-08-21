import { describe, expect, it } from 'vitest';

import { MemoryPlatformRepository } from './memory-repository.js';
import { HttpProblem } from './problems.js';
import { SessionIndexBridge } from './session-index-bridge.js';

describe('SessionIndexBridge', () => {
  it('restores an index idempotently from the same user volume', async () => {
    const repository = new MemoryPlatformRepository('tenant-a');
    const bridge = new SessionIndexBridge(repository);
    const owner = { tenantId: 'tenant-a', userId: 'user-a' };
    const snapshot = { sessionId: 'session-1', lastEventPosition: 8, lastEventAt: new Date() };
    await bridge.reconcile(owner, [snapshot]);
    const restored = await bridge.reconcile(owner, [{ ...snapshot, lastEventPosition: 12 }]);
    expect(restored[0]).toMatchObject({ userId: 'user-a', lastEventPosition: 12 });
    expect(repository.sessions.size).toBe(1);
  });

  it('rejects an owner conflict instead of reassigning the Session', async () => {
    const repository = new MemoryPlatformRepository('tenant-a');
    const bridge = new SessionIndexBridge(repository);
    await bridge.register({ tenantId: 'tenant-a', userId: 'user-a' }, { sessionId: 'session-1' });
    await expect(
      bridge.register({ tenantId: 'tenant-a', userId: 'user-b' }, { sessionId: 'session-1' }),
    ).rejects.toBeInstanceOf(HttpProblem);
    expect((await repository.getSessionById('session-1'))?.userId).toBe('user-a');
  });
});
