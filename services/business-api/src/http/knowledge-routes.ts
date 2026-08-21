import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { KnowledgeService } from '../application/knowledge-service.js';
import type { KnowledgeCategoryCode } from '../domain/models.js';
import {
  cursorLimit,
  parseIdempotencyKey,
  uuid,
  versionedReason,
  expectedVersion,
} from './schemas.js';
import { presentKnowledgeUpload } from './presenters.js';

const scope = z.enum(['company', 'personal']);
const status = z.enum([
  'pending_review',
  'ready',
  'rejected',
  'archived',
  'pending_purge',
  'purging',
]);

export function registerKnowledgeRoutes(app: FastifyInstance, service: KnowledgeService): void {
  app.get('/knowledge/categories', async (request) => {
    const query = z.object({ scope }).strict().parse(request.query);
    return service.listCategories(request.actor, query.scope);
  });

  app.get('/knowledge/documents', async (request) => {
    const query = cursorLimit
      .extend({ scope, category: z.string().optional(), status: status.optional() })
      .strict()
      .parse(request.query);
    return service.listDocuments(request.actor, query);
  });

  app.post('/knowledge/uploads', async (request, reply) => {
    const body = z
      .object({
        scope,
        category: z.string().nullable().optional().default(null),
        title: z.string().trim().min(1).max(200),
        file_name: z.string().trim().min(1).max(255),
        media_type: z.string().trim().min(1).max(255),
        size_bytes: z.number().int().nonnegative(),
        scenario: z.enum(['success', 'fail']).optional().default('success'),
      })
      .strict()
      .parse(request.body);
    const result = await service.createUpload(
      request.actor,
      { ...body, category: body.category as KnowledgeCategoryCode | null },
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(presentKnowledgeUpload(result.body));
  });

  app.get('/knowledge/uploads/:upload_id', async (request) => {
    const params = z.object({ upload_id: uuid }).parse(request.params);
    return presentKnowledgeUpload(await service.getUpload(request.actor, params.upload_id));
  });

  app.post('/knowledge/documents/:document_id/archive', async (request) => {
    const params = z.object({ document_id: uuid }).parse(request.params);
    const body = versionedReason.parse(request.body);
    const result = await service.archive(
      request.actor,
      params.document_id,
      body.expected_version,
      body.reason ?? null,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return result.body;
  });

  app.post('/knowledge/documents/:document_id/restore', async (request) => {
    const params = z.object({ document_id: uuid }).parse(request.params);
    const body = versionedReason.parse(request.body);
    const result = await service.restore(
      request.actor,
      params.document_id,
      body.expected_version,
      body.reason ?? null,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return result.body;
  });

  app.post('/knowledge/documents/:document_id/reindex', async (request, reply) => {
    const params = z.object({ document_id: uuid }).parse(request.params);
    const body = expectedVersion.parse(request.body);
    const result = await service.reindex(
      request.actor,
      params.document_id,
      body.expected_version,
      parseIdempotencyKey(request.headers['idempotency-key']),
    );
    return reply.code(result.statusCode).send(presentKnowledgeUpload(result.body));
  });
}
