import { basename } from 'node:path';

import type { PlatformRepository, SessionRecord, SessionStatus } from './domain.js';
import { HttpProblem } from './problems.js';

export type RunnerSessionSnapshot = {
  sessionId: string;
  workspaceId?: string;
  cwd?: string;
  title?: string | null;
  status?: SessionStatus;
  lastEventPosition?: number | null;
  lastEventAt?: Date | null;
  createdAt?: Date;
};

export type SessionOwner = { tenantId: string; userId: string };

export class SessionIndexBridge {
  constructor(private readonly repository: PlatformRepository) {}

  async assertOwned(userId: string, sessionId: string): Promise<SessionRecord> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session || session.userId !== userId) {
      throw new HttpProblem(404, 'session_not_found', 'Session was not found');
    }
    return session;
  }

  async reconcile(
    owner: SessionOwner,
    snapshots: readonly RunnerSessionSnapshot[],
  ): Promise<SessionRecord[]> {
    const unique = new Map<string, RunnerSessionSnapshot>();
    for (const snapshot of snapshots) {
      if (!snapshot.sessionId || snapshot.sessionId.length > 512) {
        throw new HttpProblem(
          400,
          'session_snapshot_invalid',
          'Runner returned an invalid Session id',
        );
      }
      unique.set(snapshot.sessionId, snapshot);
    }
    const reconciled: SessionRecord[] = [];
    for (const snapshot of unique.values()) reconciled.push(await this.register(owner, snapshot));
    return reconciled;
  }

  async register(owner: SessionOwner, snapshot: RunnerSessionSnapshot): Promise<SessionRecord> {
    const existing = await this.repository.getSessionById(snapshot.sessionId);
    if (existing && existing.userId !== owner.userId) {
      throw new HttpProblem(403, 'session_owner_mismatch', 'Session belongs to another user');
    }
    const now = new Date();
    const workspaceId = snapshot.workspaceId ?? `dsh-user:${owner.userId}`;
    await this.repository.upsertWorkspace({
      workspaceId,
      tenantId: owner.tenantId,
      userId: owner.userId,
      logicalName: snapshot.cwd ? basename(snapshot.cwd) || 'workspace' : 'default',
      storageRef: `runner-volume:${owner.userId}`,
      version: existing ? existing.version : 1,
      createdAt: existing?.createdAt ?? snapshot.createdAt ?? now,
      updatedAt: now,
    });
    return this.repository.upsertSession({
      sessionId: snapshot.sessionId,
      tenantId: owner.tenantId,
      userId: owner.userId,
      workspaceId,
      title: snapshot.title ?? existing?.title ?? null,
      status: snapshot.status ?? existing?.status ?? 'active',
      lastEventPosition: snapshot.lastEventPosition ?? existing?.lastEventPosition ?? null,
      lastEventAt: snapshot.lastEventAt ?? existing?.lastEventAt ?? null,
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? snapshot.createdAt ?? now,
      updatedAt: now,
    });
  }
}
