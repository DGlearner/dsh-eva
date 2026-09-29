import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  StaleRunnerFenceError,
  type DockerContainerState,
  type DockerRunnerPort,
  type Lease,
  type LeaseStore,
  type RunnerContainerSpec,
} from './domain.js';
import { MemoryLeaseStore } from './lease.js';
import { RunnerBusyError, RunnerManager } from './manager.js';
import { MemoryRunnerRepository } from './memory-repository.js';
import { RunnerResourceTemplate } from './resource-template.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userA = '00000000-0000-4000-8000-000000001003';
const userB = '00000000-0000-4000-8000-000000001004';

class FakeDocker implements DockerRunnerPort {
  readonly specs: RunnerContainerSpec[] = [];
  readonly states = new Map<string, DockerContainerState>();
  readonly names = new Map<string, string>();
  readonly runnerIds = new Map<string, string>();
  stopDelayMs = 0;
  inspectDelayMs = 0;
  afterCreate: (() => Promise<void>) | null = null;
  inspectFailures = new Set<string>();
  startingInspections = 0;

  async createAndStart(spec: RunnerContainerSpec): Promise<DockerContainerState> {
    if (this.names.has(spec.name)) throw new Error('container_name_conflict');
    this.specs.push(spec);
    const state = {
      containerId: `container-${this.specs.length}`,
      running: true,
      health: 'healthy' as const,
      internalEndpoint: `http://${spec.name}:${spec.internalPort}`,
      internalPort: spec.internalPort,
    };
    this.states.set(state.containerId, state);
    this.names.set(spec.name, state.containerId);
    this.runnerIds.set(state.containerId, spec.runnerId);
    await this.afterCreate?.();
    return state;
  }

  async inspect(containerId: string) {
    if (this.inspectDelayMs > 0) await delay(this.inspectDelayMs);
    if (this.inspectFailures.has(containerId)) throw new Error('inspect_failed');
    const state = this.states.get(containerId) ?? null;
    if (state?.health === 'starting' && this.startingInspections > 0) {
      this.startingInspections -= 1;
      return state;
    }
    if (state?.health === 'starting') {
      const healthy = { ...state, health: 'healthy' as const };
      this.states.set(containerId, healthy);
      return healthy;
    }
    return state;
  }
  async stop(containerId: string) {
    if (this.stopDelayMs > 0) await delay(this.stopDelayMs);
    const state = this.states.get(containerId);
    if (state) this.states.set(containerId, { ...state, running: false, health: 'unhealthy' });
  }
  async listManaged() {
    return [...this.states.keys()].flatMap((containerId) => {
      const runnerId = this.runnerIds.get(containerId);
      const spec = this.specs.find((candidate) => candidate.runnerId === runnerId);
      return runnerId && spec ? [{ containerId, runnerId, userId: spec.userId }] : [];
    });
  }
  async remove(containerId: string) {
    this.states.delete(containerId);
    this.runnerIds.delete(containerId);
    for (const [name, id] of this.names) {
      if (id === containerId) this.names.delete(name);
    }
  }
}

class CountingLeaseStore extends MemoryLeaseStore {
  renewals = 0;

  override async renew(lease: Lease, ttlMs: number) {
    this.renewals += 1;
    return super.renew(lease, ttlMs);
  }
}

class FailingLeaseStore implements LeaseStore {
  renewals = 0;

  constructor(private readonly failAt: number) {}

  async acquire(key: string, holder: string, ttlMs: number): Promise<Lease> {
    return { key, holder, fencingToken: 1, expiresAt: new Date(Date.now() + ttlMs) };
  }

  async renew(lease: Lease, ttlMs: number): Promise<Lease | null> {
    this.renewals += 1;
    return this.renewals >= this.failAt
      ? null
      : { ...lease, expiresAt: new Date(Date.now() + ttlMs) };
  }

  async release(): Promise<void> {}
}

describe('RunnerManager', () => {
  it('isolates user volumes and reuses the volume after runner replacement', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-test-'));
    const docker = new FakeDocker();
    const manager = new RunnerManager({
      repository: new MemoryRunnerRepository(),
      docker,
      leases: new MemoryLeaseStore(),
      template: new RunnerResourceTemplate({
        image: 'company-dsh:test',
        imageVersion: 'test',
        dataRoot,
        runnerIdentityRootSecret: Buffer.alloc(32, 8),
        agentToolGatewayUrl:
          'http://control-plane:8080/internal/v1/agent-tools/query-company-system',
      }),
      healthAttempts: 1,
      healthIntervalMs: 0,
    });
    await activateConfig(dataRoot, userA, 1);
    await activateConfig(dataRoot, userB, 1);
    const first = await manager.ensure({ tenantId, userId: userA, configVersion: 1 });
    await manager.ensure({ tenantId, userId: userB, configVersion: 1 });
    expect(docker.specs[0]?.userDataPath).not.toBe(docker.specs[1]?.userDataPath);

    const sessionPath = join(docker.specs[0]!.sessionsDataPath, 'session-fixture.jsonl');
    await writeFile(sessionPath, '{"type":"session","id":"session-a"}\n');
    await manager.stop(first.id, 'test rebuild', 0);
    await activateConfig(dataRoot, userA, 2);
    await manager.ensure({ tenantId, userId: userA, configVersion: 2 });
    expect(docker.specs[2]?.userDataPath).not.toBe(docker.specs[0]?.userDataPath);
    expect(docker.specs[2]?.sessionsDataPath).toBe(docker.specs[0]?.sessionsDataPath);
    expect(await readFile(sessionPath, 'utf8')).toContain('session-a');
  });

  it('marks a running unhealthy container failed during reconcile', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-unhealthy-'));
    const docker = new FakeDocker();
    const manager = new RunnerManager({
      repository: new MemoryRunnerRepository(),
      docker,
      leases: new MemoryLeaseStore(),
      template: new RunnerResourceTemplate({
        image: 'company-dsh:test',
        imageVersion: 'test',
        dataRoot,
        runnerIdentityRootSecret: Buffer.alloc(32, 8),
        agentToolGatewayUrl:
          'http://control-plane:8080/internal/v1/agent-tools/query-company-system',
      }),
      healthAttempts: 1,
      healthIntervalMs: 0,
    });
    await activateConfig(dataRoot, userA, 1);
    const runner = await manager.ensure({ tenantId, userId: userA, configVersion: 1 });
    docker.states.set(runner.containerId!, {
      containerId: runner.containerId!,
      running: true,
      health: 'unhealthy',
      internalEndpoint: runner.internalEndpoint,
      internalPort: 3000,
    });

    await expect(manager.reconcile(runner.id)).resolves.toMatchObject({
      state: 'failed',
      health: 'unhealthy',
    });
  });

  it('renews the lease while health inspection exceeds the original TTL', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-slow-health-'));
    await activateConfig(dataRoot, userA, 1);
    const docker = new FakeDocker();
    docker.inspectDelayMs = 12;
    docker.startingInspections = 3;
    const leases = new CountingLeaseStore();
    const manager = createManager(dataRoot, docker, leases, {
      leaseTtlMs: 24,
      healthAttempts: 6,
      healthIntervalMs: 4,
    });

    await expect(
      manager.ensure({ tenantId, userId: userA, configVersion: 1 }),
    ).resolves.toMatchObject({ state: 'ready' });
    expect(leases.renewals).toBeGreaterThan(4);
  });

  it('renews the lease while Docker stop exceeds the original TTL', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-slow-stop-'));
    await activateConfig(dataRoot, userA, 1);
    const docker = new FakeDocker();
    const leases = new CountingLeaseStore();
    const manager = createManager(dataRoot, docker, leases, { leaseTtlMs: 24 });
    const runner = await manager.ensure({ tenantId, userId: userA, configVersion: 1 });
    const renewalsBeforeStop = leases.renewals;
    docker.stopDelayMs = 45;

    await expect(manager.stop(runner.id, 'slow stop', 1)).resolves.toMatchObject({
      state: 'stopped',
      containerId: null,
    });
    expect(leases.renewals).toBeGreaterThan(renewalsBeforeStop + 2);
  });

  it('does not create a container or write more state after lease renewal is lost', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-lost-lease-'));
    await activateConfig(dataRoot, userA, 1);
    const docker = new FakeDocker();
    const repository = new MemoryRunnerRepository();
    let saves = 0;
    const originalSave = repository.save.bind(repository);
    repository.save = async (...args) => {
      saves += 1;
      return originalSave(...args);
    };
    const manager = new RunnerManager({
      repository,
      docker,
      leases: new FailingLeaseStore(3),
      template: template(dataRoot),
      leaseTtlMs: 10_000,
      healthAttempts: 1,
      healthIntervalMs: 0,
    });

    await expect(manager.ensure({ tenantId, userId: userA, configVersion: 1 })).rejects.toThrow(
      'lease was lost',
    );
    expect(docker.specs).toHaveLength(0);
    expect(saves).toBe(0);
    expect(await repository.list()).toHaveLength(1);
  });

  it('does not revive an expired lease and advances the replacement fencing token', async () => {
    const leases = new MemoryLeaseStore();
    const original = await leases.acquire('runner-lease:expired', 'holder-a', 5);
    expect(original).not.toBeNull();
    await delay(10);

    await expect(leases.renew(original!, 100)).resolves.toBeNull();
    const replacement = await leases.acquire('runner-lease:expired', 'holder-b', 100);
    expect(replacement?.fencingToken).toBe((original?.fencingToken ?? 0) + 1);
  });

  it('allows only one active container for two concurrent ensure calls', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-concurrent-'));
    await activateConfig(dataRoot, userA, 1);
    const docker = new FakeDocker();
    docker.inspectDelayMs = 20;
    const manager = createManager(dataRoot, docker, new MemoryLeaseStore());

    const results = await Promise.allSettled([
      manager.ensure({ tenantId, userId: userA, configVersion: 1 }),
      manager.ensure({ tenantId, userId: userA, configVersion: 1 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({ reason: expect.any(RunnerBusyError) });
    expect(docker.states).toHaveLength(1);
    expect(new Set(docker.specs.map((spec) => spec.name))).toHaveLength(1);
  });

  it('rejects state writes with a stale fencing token', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-fence-'));
    await activateConfig(dataRoot, userA, 1);
    const repository = new MemoryRunnerRepository();
    const manager = new RunnerManager({
      repository,
      docker: new FakeDocker(),
      leases: new MemoryLeaseStore(),
      template: template(dataRoot),
      healthAttempts: 1,
      healthIntervalMs: 0,
    });
    const runner = await manager.ensure({ tenantId, userId: userA, configVersion: 1 });

    await expect(repository.save(runner, runner.fencingToken - 1)).rejects.toBeInstanceOf(
      StaleRunnerFenceError,
    );
  });

  it('continues reconcileAll when one container inspection fails', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-reconcile-all-'));
    await activateConfig(dataRoot, userA, 1);
    await activateConfig(dataRoot, userB, 1);
    const docker = new FakeDocker();
    const manager = createManager(dataRoot, docker, new MemoryLeaseStore());
    const runnerA = await manager.ensure({ tenantId, userId: userA, configVersion: 1 });
    const runnerB = await manager.ensure({ tenantId, userId: userB, configVersion: 1 });
    docker.inspectFailures.add(runnerA.containerId!);
    docker.states.set(runnerB.containerId!, {
      ...docker.states.get(runnerB.containerId!)!,
      health: 'unhealthy',
    });

    const reconciled = await manager.reconcileAll();
    expect(reconciled.find((runner) => runner.id === runnerB.id)).toMatchObject({
      state: 'failed',
      health: 'unhealthy',
    });
  });

  it('does not remove a container while ensure is publishing its container id', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'company-runner-reconcile-race-'));
    await activateConfig(dataRoot, userA, 1);
    const docker = new FakeDocker();
    const created = deferred<void>();
    const publish = deferred<void>();
    docker.afterCreate = async () => {
      created.resolve();
      await publish.promise;
    };
    const manager = createManager(dataRoot, docker, new MemoryLeaseStore());

    const ensuring = manager.ensure({ tenantId, userId: userA, configVersion: 1 });
    await created.promise;
    await manager.reconcileAll();
    expect(docker.states.size).toBe(1);

    publish.resolve();
    await expect(ensuring).resolves.toMatchObject({ state: 'ready' });
    expect(docker.states.size).toBe(1);
  });
});

function template(dataRoot: string) {
  return new RunnerResourceTemplate({
    image: 'company-dsh:test',
    imageVersion: 'test',
    dataRoot,
    runnerIdentityRootSecret: Buffer.alloc(32, 8),
    agentToolGatewayUrl: 'http://control-plane:8080/internal/v1/agent-tools/query-company-system',
  });
}

function createManager(
  dataRoot: string,
  docker: FakeDocker,
  leases: LeaseStore,
  options: { leaseTtlMs?: number; healthAttempts?: number; healthIntervalMs?: number } = {},
) {
  return new RunnerManager({
    repository: new MemoryRunnerRepository(),
    docker,
    leases,
    template: template(dataRoot),
    healthAttempts: options.healthAttempts ?? 1,
    healthIntervalMs: options.healthIntervalMs ?? 0,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
}

async function activateConfig(dataRoot: string, userId: string, configVersion: number) {
  const stageId = `00000000-0000-4000-8000-${String(configVersion).padStart(12, '0')}`;
  const userRoot = join(dataRoot, userId);
  const homePath = join(userRoot, 'configurations', `${configVersion}-${stageId}`, 'home');
  await mkdir(homePath, { recursive: true });
  await writeFile(
    join(userRoot, 'active-config.json'),
    JSON.stringify({ stage_id: stageId, config_version: configVersion, home_path: homePath }),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
