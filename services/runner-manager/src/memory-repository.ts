import { StaleRunnerFenceError, type RunnerRecord, type RunnerRepository } from './domain.js';

export class MemoryRunnerRepository implements RunnerRepository {
  readonly records = new Map<string, RunnerRecord>();
  readonly fences = new Map<string, number>();

  async get(runnerId: string): Promise<RunnerRecord | null> {
    const record = this.records.get(runnerId);
    return record ? structuredClone(record) : null;
  }

  async getActiveByUser(userId: string): Promise<RunnerRecord | null> {
    const active = new Set(['starting', 'ready', 'busy', 'idle', 'stopping']);
    const record = [...this.records.values()].find(
      (candidate) => candidate.userId === userId && active.has(candidate.state),
    );
    return record ? structuredClone(record) : null;
  }

  async list(): Promise<RunnerRecord[]> {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async create(record: RunnerRecord, fencingToken: number): Promise<void> {
    this.claimFence(record.userId, fencingToken);
    if (await this.getActiveByUser(record.userId)) throw new Error('active_runner_conflict');
    this.records.set(record.id, structuredClone({ ...record, fencingToken }));
  }

  async save(record: RunnerRecord, fencingToken: number): Promise<RunnerRecord> {
    this.claimFence(record.userId, fencingToken);
    const current = this.records.get(record.id);
    if (!current || current.fencingToken > fencingToken) {
      throw new StaleRunnerFenceError('Runner state write was fenced out');
    }
    const updated = {
      ...record,
      fencingToken,
      version: current ? current.version + 1 : record.version,
      updatedAt: new Date(),
    };
    this.records.set(record.id, updated);
    return structuredClone(updated);
  }

  private claimFence(userId: string, fencingToken: number): void {
    const current = this.fences.get(userId) ?? 0;
    if (fencingToken < current) {
      throw new StaleRunnerFenceError('Runner lifecycle holder was fenced out');
    }
    this.fences.set(userId, fencingToken);
  }
}
