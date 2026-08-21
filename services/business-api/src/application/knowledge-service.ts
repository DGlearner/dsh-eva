import { randomUUID } from 'node:crypto';

import { badRequest, conflict, forbidden, notFound, versionConflict } from '../domain/errors.js';
import { canMutateKnowledge } from '../domain/policies.js';
import type {
  ActorContext,
  KnowledgeCategory,
  KnowledgeCategoryCode,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeScope,
  KnowledgeUpload,
  Page,
} from '../domain/models.js';
import type { Clock } from '../ports/clock.js';
import type { BusinessRepository } from '../ports/repository.js';
import { executeIdempotent, paginate, writeAudit, type IdempotentResult } from './shared.js';

const companyCategories = new Set<KnowledgeCategoryCode>([
  'company-information',
  'xiaopai-design',
  'patent-document',
]);

export interface CreateKnowledgeUploadInput {
  scope: KnowledgeScope;
  category: KnowledgeCategoryCode | null;
  title: string;
  file_name: string;
  media_type: string;
  size_bytes: number;
  scenario: 'success' | 'fail';
}

export class KnowledgeService {
  constructor(
    private readonly repository: BusinessRepository,
    private readonly clock: Clock,
  ) {}

  async listCategories(actor: ActorContext, scope: KnowledgeScope): Promise<KnowledgeCategory[]> {
    void actor;
    return this.repository.listKnowledgeCategories(scope);
  }

  async listDocuments(
    actor: ActorContext,
    filters: {
      scope: KnowledgeScope;
      category?: string;
      status?: KnowledgeDocumentStatus;
      cursor: string | null;
      limit: number;
    },
  ): Promise<Page<KnowledgeDocument>> {
    if (filters.scope === 'personal' && filters.category !== undefined) {
      throw badRequest(
        'personal_category_not_allowed',
        'Personal knowledge does not use categories.',
      );
    }
    if (
      filters.category !== undefined &&
      !companyCategories.has(filters.category as KnowledgeCategoryCode)
    ) {
      throw badRequest('invalid_knowledge_category', 'Knowledge category is invalid.');
    }
    const visible = (await this.repository.listKnowledgeDocuments(actor.tenantId))
      .filter((document) => document.scope === filters.scope)
      .filter((document) => document.scope === 'company' || document.owner_user_id === actor.userId)
      .filter(
        (document) => filters.category === undefined || document.category === filters.category,
      )
      .filter((document) => filters.status === undefined || document.status === filters.status)
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
      );
    return paginate(visible, filters.cursor, filters.limit);
  }

  async createUpload(
    actor: ActorContext,
    input: CreateKnowledgeUploadInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<KnowledgeUpload>> {
    this.assertUploadPermission(actor, input);
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: 'POST /knowledge/uploads',
      key: idempotencyKey,
      request: input,
      statusCode: 202,
      execute: async () => {
        const now = this.clock.now().toISOString();
        const documentId = randomUUID();
        const uploadId = randomUUID();
        const document: KnowledgeDocument = {
          id: documentId,
          knowledge_id: `fake/${input.scope}/${documentId}`,
          scope: input.scope,
          owner_user_id: input.scope === 'personal' ? actor.userId : null,
          category: input.scope === 'company' ? input.category : null,
          title: input.title,
          file_name: input.file_name,
          media_type: input.media_type,
          size_bytes: input.size_bytes,
          status: 'pending_review',
          version: 1,
          updated_at: now,
        };
        const upload: KnowledgeUpload = {
          id: uploadId,
          document_id: documentId,
          owner_user_id: actor.userId,
          status: 'queued',
          progress: 0,
          error_code: null,
          version: 1,
          scenario: input.scenario,
          poll_count: 0,
          created_at: now,
          updated_at: now,
        };
        await this.repository.createKnowledgeUpload({ document, upload });
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: 'knowledge.upload.created',
          resourceType: 'knowledge_upload',
          resourceId: upload.id,
          details: { scope: input.scope, scenario: input.scenario },
        });
        return this.publicUpload(upload);
      },
    });
  }

  async getUpload(actor: ActorContext, uploadId: string): Promise<KnowledgeUpload> {
    return this.repository.transaction(async () => {
      const upload = await this.repository.getKnowledgeUpload(actor.tenantId, uploadId);
      if (upload === null || upload.owner_user_id !== actor.userId)
        throw notFound('Knowledge upload');
      if (upload.status === 'succeeded' || upload.status === 'failed')
        return this.publicUpload(upload);

      const pollCount = (upload.poll_count ?? 0) + 1;
      const now = this.clock.now().toISOString();
      const next = {
        ...upload,
        poll_count: pollCount,
        updated_at: now,
        version: upload.version + 1,
      };
      if (pollCount === 1) {
        next.status = 'running';
        next.progress = 35;
      } else if (upload.scenario === 'fail') {
        next.status = 'failed';
        next.progress = 35;
        next.error_code = 'fixture_parse_failed';
      } else if (pollCount === 2) {
        next.status = 'running';
        next.progress = 80;
      } else {
        next.status = 'succeeded';
        next.progress = 100;
        const document = await this.repository.getKnowledgeDocument(
          actor.tenantId,
          next.document_id,
        );
        if (document !== null) {
          await this.repository.saveKnowledgeDocument(
            { ...document, status: 'ready', version: document.version + 1, updated_at: now },
            document.version,
          );
        }
      }
      await this.repository.saveKnowledgeUpload(next, upload.version);
      return this.publicUpload(next);
    });
  }

  async archive(
    actor: ActorContext,
    documentId: string,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<IdempotentResult<KnowledgeDocument>> {
    return this.changeDocumentStatus(
      actor,
      documentId,
      expectedVersion,
      'archived',
      ['ready', 'pending_review', 'rejected'],
      reason,
      'archive',
      idempotencyKey,
    );
  }

  async restore(
    actor: ActorContext,
    documentId: string,
    expectedVersion: number,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<IdempotentResult<KnowledgeDocument>> {
    return this.changeDocumentStatus(
      actor,
      documentId,
      expectedVersion,
      'ready',
      ['archived'],
      reason,
      'restore',
      idempotencyKey,
    );
  }

  async reindex(
    actor: ActorContext,
    documentId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<IdempotentResult<KnowledgeUpload>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /knowledge/documents/${documentId}/reindex`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion },
      statusCode: 202,
      execute: async () => {
        const document = await this.mutableDocument(actor, documentId);
        if (document.version !== expectedVersion) throw versionConflict(document.version);
        if (document.status === 'pending_purge' || document.status === 'purging') {
          throw conflict('knowledge_document_not_reindexable', 'Document cannot be reindexed.');
        }
        const now = this.clock.now().toISOString();
        const upload: KnowledgeUpload = {
          id: randomUUID(),
          document_id: document.id,
          owner_user_id: actor.userId,
          status: 'queued',
          progress: 0,
          error_code: null,
          version: 1,
          scenario: 'success',
          poll_count: 0,
          created_at: now,
          updated_at: now,
        };
        await this.repository.saveKnowledgeDocument(
          { ...document, status: 'pending_review', version: document.version + 1, updated_at: now },
          document.version,
        );
        await this.repository.createKnowledgeReindex(upload);
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: 'knowledge.document.reindex_started',
          resourceType: 'knowledge_document',
          resourceId: document.id,
        });
        return this.publicUpload(upload);
      },
    });
  }

  private async changeDocumentStatus(
    actor: ActorContext,
    documentId: string,
    expectedVersion: number,
    target: KnowledgeDocumentStatus,
    allowed: KnowledgeDocumentStatus[],
    reason: string | null,
    action: 'archive' | 'restore',
    idempotencyKey: string,
  ): Promise<IdempotentResult<KnowledgeDocument>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /knowledge/documents/${documentId}/${action}`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion, reason },
      statusCode: 200,
      execute: async () => {
        const document = await this.mutableDocument(actor, documentId);
        if (document.version !== expectedVersion) throw versionConflict(document.version);
        if (!allowed.includes(document.status)) {
          throw conflict(
            'invalid_knowledge_status_transition',
            `Document cannot transition from ${document.status} to ${target}.`,
          );
        }
        const updated = {
          ...document,
          status: target,
          version: document.version + 1,
          updated_at: this.clock.now().toISOString(),
        };
        await this.repository.saveKnowledgeDocument(updated, document.version);
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: `knowledge.document.${action}`,
          resourceType: 'knowledge_document',
          resourceId: document.id,
          details: { reason },
        });
        return updated;
      },
    });
  }

  private async mutableDocument(
    actor: ActorContext,
    documentId: string,
  ): Promise<KnowledgeDocument> {
    const document = await this.repository.getKnowledgeDocument(actor.tenantId, documentId);
    if (document === null) throw notFound('Knowledge document');
    if (!canMutateKnowledge(actor, document)) throw forbidden();
    return document;
  }

  private assertUploadPermission(actor: ActorContext, input: CreateKnowledgeUploadInput): void {
    if (input.scope === 'company') {
      if (actor.platformRole !== 'admin')
        throw forbidden('Only platform admins manage company knowledge.');
      if (input.category === null || !companyCategories.has(input.category)) {
        throw badRequest(
          'company_category_required',
          'Company knowledge requires a valid category.',
        );
      }
    } else if (input.category !== null) {
      throw badRequest(
        'personal_category_not_allowed',
        'Personal knowledge does not use categories.',
      );
    }
  }

  private publicUpload(upload: KnowledgeUpload): KnowledgeUpload {
    const {
      owner_user_id: _owner,
      scenario: _scenario,
      poll_count: _polls,
      version: _version,
      ...rest
    } = upload;
    return rest as KnowledgeUpload;
  }
}
