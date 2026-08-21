import { randomUUID } from 'node:crypto';

import type {
  DockerContainerState,
  DockerRunnerPort,
  LeaseStore,
  RunnerRecord,
  RunnerRepository,
} from './domain.js';
import { RenewingRunnerLease } from './lease-guard.js';
import { RunnerResourceTemplate } from './resource-template.js';

export class RunnerBusyError extends Error {}
export class RunnerNotFoundError extends Error {}

export type RunnerManagerOptions = {
  repository: RunnerRepository;
  docker: DockerRunnerPort;
  leases: LeaseStore;
  template: RunnerResourceTemplate;
  leaseTtlMs?: number;
  healthAttempts?: number;
  healthIntervalMs?: number;
};

export class RunnerManager {
  private readonly leaseTtlMs: number;
  private readonly healthAttempts: number;
  private readonly healthIntervalMs: number;

  constructor(private readonly options: RunnerManagerOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.healthAttempts = options.healthAttempts ?? 24;
    this.healthIntervalMs = options.healthIntervalMs ?? 500;
  }

  async ensure(input: {
    tenantId: string;
    userId: string;
    configVersion: number;
  }): Promise<RunnerRecord> {
    const key = `runner-lease:${input.userId}`;
    const lease = await RenewingRunnerLease.acquire(this.options.leases, key, this.leaseTtlMs);
    if (!lease) throw new RunnerBusyError('Runner lifecycle operation is already in progress');

    try {
      await lease.checkpoint();
      const current = await this.options.repository.getActiveByUser(input.userId);
      if (current && current.configVersion === input.configVersion) {
        const reconciled = await this.reconcile(current.id, lease);
        if (
          reconciled.state === 'ready' ||
          reconciled.state === 'busy' ||
          reconciled.state === 'idle'
        ) {
          return reconciled;
        }
      }
      if (current) await this.stop(current.id, 'configuration_replaced', 30, lease);

      const now = new Date();
      let record: RunnerRecord = {
        id: randomUUID(),
        tenantId: input.tenantId,
        userId: input.userId,
        containerId: null,
        imageVersion: 'pending',
        state: 'starting',
        health: 'starting',
        internalEndpoint: null,
        configVersion: input.configVersion,
        activeRuns: 0,
        leaseExpiresAt: lease.expiresAt,
        lastActivityAt: now,
        version: 1,
        fencingToken: lease.fencingToken,
        createdAt: now,
        updatedAt: now,
      };
      const spec = await this.options.template.create({
        runnerId: record.id,
        tenantId: input.tenantId,
        userId: input.userId,
        configVersion: input.configVersion,
      });
      record.imageVersion = spec.imageVersion;
      await lease.checkpoint();
      await this.options.repository.create(record, lease.fencingToken);

      let createdContainerId: string | null = null;
      try {
        await lease.checkpoint();
        const created = await this.options.docker.createAndStart(spec);
        createdContainerId = created.containerId;
        await lease.checkpoint();
        record = await this.options.repository.save(
          {
            ...record,
            containerId: created.containerId,
            internalEndpoint: created.internalEndpoint,
            health: created.health,
          },
          lease.fencingToken,
        );
        const healthy = await this.waitForHealthy(created, lease);
        await lease.checkpoint();
        record = await this.options.repository.save(
          {
            ...record,
            state: healthy.health === 'healthy' ? 'ready' : 'failed',
            health: healthy.health,
            internalEndpoint: healthy.internalEndpoint,
            leaseExpiresAt: lease.expiresAt,
            lastActivityAt: new Date(),
          },
          lease.fencingToken,
        );
        if (record.state === 'failed') throw new Error('Runner did not become healthy');
        return record;
      } catch (error) {
        let failedContainerId = record.containerId ?? createdContainerId;
        if (failedContainerId) {
          try {
            await this.options.docker.remove(failedContainerId);
            failedContainerId = null;
          } catch {
            // Preserve the lifecycle failure; orphan cleanup is retried by reconcileAll.
          }
        }
        try {
          await lease.checkpoint();
          await this.options.repository.save(
            {
              ...record,
              containerId: failedContainerId,
              state: 'failed',
              health: 'unhealthy',
              internalEndpoint: null,
            },
            lease.fencingToken,
          );
        } catch {
          // A replacement holder owns recovery after this lease is lost.
        }
        throw error;
      }
    } finally {
      await lease.close();
    }
  }

  async get(runnerId: string): Promise<RunnerRecord> {
    const record = await this.options.repository.get(runnerId);
    if (!record) throw new RunnerNotFoundError('Runner was not found');
    return record;
  }

  async list(): Promise<RunnerRecord[]> {
    return this.options.repository.list();
  }

  async stop(
    runnerId: string,
    _reason: string,
    gracePeriodSeconds: number,
    existingLease?: RenewingRunnerLease,
  ): Promise<RunnerRecord> {
    const record = await this.get(runnerId);
    const lease =
      existingLease ??
      (await RenewingRunnerLease.acquire(
        this.options.leases,
        `runner-lease:${record.userId}`,
        this.leaseTtlMs,
      ));
    if (!lease) throw new RunnerBusyError('Runner lifecycle operation is already in progress');
    try {
      await lease.checkpoint();
      let updated = await this.options.repository.save(
        { ...record, state: 'stopping' },
        lease.fencingToken,
      );
      if (updated.containerId) {
        await this.options.docker.stop(updated.containerId, gracePeriodSeconds);
        await lease.checkpoint();
        await this.options.docker.remove(updated.containerId);
      }
      await lease.checkpoint();
      updated = await this.options.repository.save(
        {
          ...updated,
          containerId: null,
          state: 'stopped',
          health: 'unknown',
          internalEndpoint: null,
          activeRuns: 0,
          leaseExpiresAt: null,
        },
        lease.fencingToken,
      );
      return updated;
    } finally {
      if (!existingLease) await lease.close();
    }
  }

  async reconcile(runnerId: string, existingLease?: RenewingRunnerLease): Promise<RunnerRecord> {
    const record = await this.get(runnerId);
    const lease =
      existingLease ??
      (await RenewingRunnerLease.acquire(
        this.options.leases,
        `runner-lease:${record.userId}`,
        this.leaseTtlMs,
      ));
    if (!lease) {
      throw new RunnerBusyError('Runner lifecycle operation is already in progress');
    }
    try {
      await lease.checkpoint();
      if (!record.containerId) {
        return this.options.repository.save(
          {
            ...record,
            state: record.state === 'failed' ? 'failed' : 'stopped',
            health: 'unknown',
            internalEndpoint: null,
          },
          lease.fencingToken,
        );
      }
      const actual = await this.options.docker.inspect(record.containerId);
      await lease.checkpoint();
      if (!actual) {
        return this.options.repository.save(
          {
            ...record,
            containerId: null,
            state: record.state === 'stopping' ? 'stopped' : 'failed',
            health: 'unknown',
            internalEndpoint: null,
          },
          lease.fencingToken,
        );
      }
      if (!actual.running) {
        await this.options.docker.remove(record.containerId);
        await lease.checkpoint();
        return this.options.repository.save(
          {
            ...record,
            containerId: null,
            state: 'stopped',
            health: actual.health,
            internalEndpoint: null,
            lastActivityAt: new Date(),
          },
          lease.fencingToken,
        );
      }
      return this.options.repository.save(
        {
          ...record,
          state:
            actual.health === 'healthy'
              ? 'ready'
              : actual.health === 'unhealthy'
                ? 'failed'
                : 'starting',
          health: actual.health,
          internalEndpoint: actual.internalEndpoint,
          lastActivityAt: new Date(),
        },
        lease.fencingToken,
      );
    } finally {
      if (!existingLease) await lease.close();
    }
  }

  async reconcileAll(): Promise<RunnerRecord[]> {
    const records = await this.options.repository.list();
    const known = new Map(records.map((record) => [record.id, record]));
    const managed = await this.options.docker.listManaged();
    const active = new Set(['starting', 'ready', 'busy', 'idle', 'stopping']);
    for (const container of managed) {
      const knownRecord = known.get(container.runnerId);
      const lease = await RenewingRunnerLease.acquire(
        this.options.leases,
        `runner-lease:${knownRecord?.userId ?? container.userId}`,
        this.leaseTtlMs,
      );
      if (!lease) continue;
      try {
        await lease.checkpoint();
        const current = await this.options.repository.get(container.runnerId);
        if (current && current.userId !== (knownRecord?.userId ?? container.userId)) continue;
        const orphan =
          !current || current.containerId !== container.containerId || !active.has(current.state);
        if (!orphan) continue;
        await this.options.docker.stop(container.containerId, 10);
        await lease.checkpoint();
        await this.options.docker.remove(container.containerId);
      } catch {
        // Continue reconciling independent users and retry this container later.
      } finally {
        await lease.close();
      }
    }
    await Promise.allSettled(records.map((record) => this.reconcile(record.id)));
    return this.options.repository.list();
  }

  private async waitForHealthy(
    initial: DockerContainerState,
    lease: RenewingRunnerLease,
  ): Promise<DockerContainerState> {
    let state = initial;
    for (let attempt = 0; attempt < this.healthAttempts; attempt += 1) {
      await lease.checkpoint();
      const inspected = await this.options.docker.inspect(initial.containerId);
      if (!inspected) return { ...initial, running: false, health: 'unhealthy' };
      state = inspected;
      if (state.health === 'healthy' || state.health === 'unhealthy') return state;
      if (this.healthIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.healthIntervalMs));
      }
    }
    return { ...state, health: 'unhealthy' };
  }
}
