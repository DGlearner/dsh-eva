import type { Redis } from 'ioredis';

import type { Lease, LeaseStore } from './domain.js';

export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();
  private readonly fences = new Map<string, number>();

  async acquire(key: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const now = new Date();
    const existing = this.leases.get(key);
    if (existing && existing.expiresAt > now) return null;
    const fencingToken = (this.fences.get(key) ?? 0) + 1;
    this.fences.set(key, fencingToken);
    const lease = { key, holder, fencingToken, expiresAt: new Date(now.getTime() + ttlMs) };
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async renew(lease: Lease, ttlMs: number): Promise<Lease | null> {
    const current = this.leases.get(lease.key);
    if (
      !current ||
      current.holder !== lease.holder ||
      current.fencingToken !== lease.fencingToken ||
      current.expiresAt.getTime() <= Date.now()
    ) {
      if (current && current.expiresAt.getTime() <= Date.now()) this.leases.delete(lease.key);
      return null;
    }
    const renewed = { ...current, expiresAt: new Date(Date.now() + ttlMs) };
    this.leases.set(lease.key, renewed);
    return structuredClone(renewed);
  }

  async release(lease: Lease): Promise<void> {
    const current = this.leases.get(lease.key);
    if (current?.holder === lease.holder && current.fencingToken === lease.fencingToken) {
      this.leases.delete(lease.key);
    }
  }
}

const RENEW_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisLeaseStore implements LeaseStore {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const fencingToken = await this.redis.incr(`${key}:fence`);
    const value = `${holder}:${fencingToken}`;
    const acquired = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;
    return { key, holder, fencingToken, expiresAt: new Date(Date.now() + ttlMs) };
  }

  async renew(lease: Lease, ttlMs: number): Promise<Lease | null> {
    const value = `${lease.holder}:${lease.fencingToken}`;
    const renewed = await this.redis.eval(RENEW_SCRIPT, 1, lease.key, value, String(ttlMs));
    return Number(renewed) === 1 ? { ...lease, expiresAt: new Date(Date.now() + ttlMs) } : null;
  }

  async release(lease: Lease): Promise<void> {
    const value = `${lease.holder}:${lease.fencingToken}`;
    await this.redis.eval(RELEASE_SCRIPT, 1, lease.key, value);
  }
}
