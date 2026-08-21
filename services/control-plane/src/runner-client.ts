import { randomUUID } from 'node:crypto';

import type { DshRunnerLocator, LocatedRunner } from './gateway.js';

export class RunnerManagerHttpClient implements DshRunnerLocator {
  constructor(
    private readonly endpoint: string,
    private readonly serviceToken: string,
  ) {}

  async ensure(input: {
    tenantId: string;
    userId: string;
    configVersion: number;
    requestId: string;
  }): Promise<LocatedRunner> {
    const value = await this.request('/internal/v1/runners/ensure', {
      method: 'POST',
      requestId: input.requestId,
      idempotencyKey: randomUUID(),
      body: {
        tenant_id: input.tenantId,
        user_id: input.userId,
        config_version: input.configVersion,
      },
    });
    if (
      typeof value.id !== 'string' ||
      value.tenant_id !== input.tenantId ||
      value.user_id !== input.userId ||
      value.config_version !== input.configVersion ||
      typeof value.internal_endpoint !== 'string' ||
      !['ready', 'busy', 'idle'].includes(String(value.state))
    ) {
      throw new Error('Runner Manager returned a non-ready runner');
    }
    return { runnerId: value.id, internalEndpoint: value.internal_endpoint };
  }

  async list(tenantId?: string): Promise<unknown[]> {
    const value = await this.request('/internal/v1/runners', {
      method: 'GET',
      requestId: randomUUID(),
    });
    if (!Array.isArray(value.items)) throw new Error('Runner Manager returned an invalid list');
    return value.items.filter(
      (item) =>
        !tenantId ||
        (item !== null &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).tenant_id === tenantId),
    );
  }

  async stopForUser(userId: string, reason: string): Promise<void> {
    const runners = await this.list();
    const matching = runners.filter(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).user_id === userId &&
        !['stopped', 'failed'].includes(String((item as Record<string, unknown>).state)),
    );
    await Promise.all(
      matching.map(async (item) => {
        const runnerId = (item as Record<string, unknown>).id;
        if (typeof runnerId !== 'string')
          throw new Error('Runner Manager returned an invalid runner');
        await this.stop(runnerId, reason, 30);
      }),
    );
  }

  async stop(runnerId: string, reason: string, gracePeriodSeconds: number): Promise<unknown> {
    return this.request(`/internal/v1/runners/${encodeURIComponent(runnerId)}/stop`, {
      method: 'POST',
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      body: { reason, grace_period_seconds: gracePeriodSeconds },
    });
  }

  private async request(
    path: string,
    input: {
      method: 'GET' | 'POST';
      requestId: string;
      idempotencyKey?: string;
      body?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, this.endpoint), {
      method: input.method,
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        'x-request-id': input.requestId,
        ...(input.body ? { 'content-type': 'application/json' } : {}),
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(`Runner Manager request failed: ${String(value.code ?? response.status)}`);
    return value;
  }
}
