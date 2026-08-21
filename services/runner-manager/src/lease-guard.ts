import { randomUUID } from 'node:crypto';

import type { Lease, LeaseStore } from './domain.js';

export class RunnerLeaseLostError extends Error {}

export class RenewingRunnerLease {
  private current: Lease;
  private lost: Error | null = null;
  private renewal = Promise.resolve();
  private readonly timer: NodeJS.Timeout;

  private constructor(
    private readonly store: LeaseStore,
    lease: Lease,
    private readonly ttlMs: number,
  ) {
    this.current = lease;
    this.timer = setInterval(() => void this.queueRenewal(), Math.max(1, Math.floor(ttlMs / 3)));
    this.timer.unref();
  }

  static async acquire(store: LeaseStore, key: string, ttlMs: number) {
    const lease = await store.acquire(key, randomUUID(), ttlMs);
    return lease ? new RenewingRunnerLease(store, lease, ttlMs) : null;
  }

  get fencingToken(): number {
    return this.current.fencingToken;
  }

  get expiresAt(): Date {
    return this.current.expiresAt;
  }

  async checkpoint(): Promise<void> {
    await this.queueRenewal();
    if (this.lost) throw this.lost;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.renewal;
    if (!this.lost) await this.store.release(this.current);
  }

  private queueRenewal(): Promise<void> {
    this.renewal = this.renewal.then(async () => {
      if (this.lost) return;
      try {
        const renewed = await this.store.renew(this.current, this.ttlMs);
        if (!renewed) {
          this.lost = new RunnerLeaseLostError('Runner lifecycle lease was lost');
          return;
        }
        this.current = renewed;
      } catch (error) {
        this.lost = new RunnerLeaseLostError(
          `Runner lifecycle lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return this.renewal;
  }
}
