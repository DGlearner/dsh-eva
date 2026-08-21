import { createHash, randomUUID } from 'node:crypto';

import { badRequest, conflict } from '../domain/errors.js';
import type { ActorContext, AuditEvent, Page } from '../domain/models.js';
import type { Clock } from '../ports/clock.js';
import type { BusinessRepository } from '../ports/repository.js';

export interface IdempotentResult<T> {
  body: T;
  statusCode: number;
  replayed: boolean;
}

export function paginate<T>(items: T[], cursor: string | null, limit: number): Page<T> {
  let offset = 0;
  if (cursor !== null) {
    try {
      const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error('invalid cursor');
      offset = parsed;
    } catch {
      throw badRequest('invalid_cursor', 'Cursor is invalid.');
    }
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    next_cursor:
      nextOffset < items.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
  };
}

export async function executeIdempotent<T>(options: {
  repository: BusinessRepository;
  clock: Clock;
  actor: ActorContext;
  route: string;
  key: string;
  request: unknown;
  statusCode: number;
  execute: () => Promise<T>;
}): Promise<IdempotentResult<T>> {
  const scope = `${options.actor.tenantId}:${options.actor.userId}:${options.route}:${options.key}`;
  return options.repository.transaction(() =>
    options.repository.withIdempotencyLock(scope, async () => {
      const requestHash = createHash('sha256')
        .update(JSON.stringify(options.request))
        .digest('hex');
      const existing = await options.repository.getIdempotencyRecord(
        options.actor.tenantId,
        options.actor.userId,
        options.route,
        options.key,
      );
      if (existing !== null && new Date(existing.expires_at) > options.clock.now()) {
        if (existing.request_hash !== requestHash) {
          throw conflict(
            'idempotency_key_reused',
            'Idempotency-Key was reused with a different request.',
          );
        }
        return {
          body: structuredClone(existing.response_json) as T,
          statusCode: existing.status_code,
          replayed: true,
        };
      }
      const body = await options.execute();
      const expiresAt = new Date(options.clock.now());
      expiresAt.setUTCDate(expiresAt.getUTCDate() + 1);
      await options.repository.putIdempotencyRecord({
        tenant_id: options.actor.tenantId,
        actor_user_id: options.actor.userId,
        route: options.route,
        key: options.key,
        request_hash: requestHash,
        status_code: options.statusCode,
        response_json: structuredClone(body),
        expires_at: expiresAt.toISOString(),
      });
      return { body, statusCode: options.statusCode, replayed: false };
    }),
  );
}

export async function writeAudit(options: {
  repository: BusinessRepository;
  clock: Clock;
  actor: ActorContext;
  action: string;
  resourceType: string;
  resourceId: string;
  result?: AuditEvent['result'];
  details?: Record<string, unknown>;
}): Promise<void> {
  await options.repository.addAuditEvent({
    id: randomUUID(),
    tenant_id: options.actor.tenantId,
    actor_user_id: options.actor.userId,
    action: options.action,
    resource_type: options.resourceType,
    resource_id: options.resourceId,
    result: options.result ?? 'success',
    request_id: options.actor.requestId,
    details: options.details ?? {},
    created_at: options.clock.now().toISOString(),
  });
}
