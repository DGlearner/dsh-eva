import fixtureJson from '@company/test-fixtures/fixture-v1' with { type: 'json' };

import { badRequest, notFound } from '../../domain/errors.js';
import type {
  KnowledgeCategoryCode,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeChunk,
  UserSummary,
  UUID,
} from '../../domain/models.js';
import type {
  KnowledgeSearchItem,
  KnowledgeToolContext,
  KnowledgeToolDocument,
  KnowledgeToolPort,
} from '../../ports/knowledge-tool.js';

interface FixtureQueryCase {
  actor_user_id: UUID;
  query: string;
  category: KnowledgeCategoryCode | null;
  score_override?: number;
  expected_document_ids: UUID[];
}

interface KnowledgeFixture {
  tenant: { id: UUID };
  users: Array<UserSummary & { status: string }>;
  knowledge: {
    documents: Array<KnowledgeDocument & { fixture_key: string }>;
    chunks: KnowledgeChunk[];
    query_cases: FixtureQueryCase[];
  };
}

const fixture = fixtureJson as unknown as KnowledgeFixture;

export class FakeKnowledgeRepository implements KnowledgeToolPort {
  getCurrentUser(context: KnowledgeToolContext) {
    this.assertTenant(context);
    const user = fixture.users.find(
      (item) => item.id === context.userId && item.status === 'active',
    );
    if (user === undefined) throw notFound('Knowledge tool user');
    return {
      user_id: user.id,
      tenant_id: context.tenantId,
      username: user.username,
      display_name: user.display_name,
    };
  }

  search(
    context: KnowledgeToolContext,
    input: { query: string; category?: KnowledgeCategoryCode | null; top_k?: number },
  ): { query: string; count: number; results: KnowledgeSearchItem[] } {
    this.assertTenant(context);
    const query = input.query.trim();
    const topK = input.top_k ?? 5;
    if (query.length < 1 || query.length > 2000) {
      throw badRequest(
        'invalid_knowledge_query',
        'Knowledge query length must be between 1 and 2000.',
      );
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
      throw badRequest('invalid_top_k', 'top_k must be between 1 and 20.');
    }
    const documents = this.visibleDocuments(context, 'ready', input.category);
    const documentMap = new Map(documents.map((document) => [document.id, document]));
    const normalized = normalize(query);
    const fixedCase = fixture.knowledge.query_cases.find(
      (item) =>
        item.actor_user_id === context.userId &&
        normalize(item.query) === normalized &&
        (item.category ?? null) === (input.category ?? null),
    );
    let chunks: Array<KnowledgeChunk & { score_override?: number }>;
    if (fixedCase !== undefined) {
      chunks = fixedCase.expected_document_ids.flatMap((documentId) => {
        const chunk = fixture.knowledge.chunks.find((item) => item.document_id === documentId);
        return chunk === undefined ? [] : [{ ...chunk, score_override: fixedCase.score_override }];
      });
    } else {
      const terms = normalized.split(/\s+/u).filter(Boolean);
      chunks = fixture.knowledge.chunks.filter((chunk) => {
        const document = documentMap.get(chunk.document_id);
        if (document === undefined) return false;
        const haystack = normalize(`${document.title} ${chunk.content}`);
        return terms.some((term) => haystack.includes(term));
      });
    }
    const results = chunks
      .flatMap((chunk): KnowledgeSearchItem[] => {
        const document = documentMap.get(chunk.document_id);
        if (document === undefined) return [];
        return [
          {
            document_id: document.id,
            knowledge_id: document.knowledge_id,
            version: document.version,
            title: document.title,
            file_name: document.file_name,
            category: document.category,
            visibility: document.scope,
            heading_path: chunk.heading_path,
            content: chunk.content,
            line_start: chunk.line_start,
            line_end: chunk.line_end,
            score: chunk.score_override ?? chunk.score,
            vector_score: chunk.vector_score,
            lexical_score: chunk.lexical_score,
          },
        ];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.document_id.localeCompare(right.document_id) ||
          left.line_start - right.line_start,
      )
      .slice(0, topK);
    return { query, count: results.length, results };
  }

  listDocuments(
    context: KnowledgeToolContext,
    input: {
      status?: KnowledgeDocumentStatus;
      category?: KnowledgeCategoryCode | null;
      limit?: number;
    },
  ): { count: number; documents: KnowledgeToolDocument[] } {
    this.assertTenant(context);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest('invalid_limit', 'limit must be between 1 and 100.');
    }
    const documents = this.visibleDocuments(context, input.status ?? 'ready', input.category)
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((document): KnowledgeToolDocument => ({
        document_id: document.id,
        knowledge_id: document.knowledge_id,
        version: document.version,
        title: document.title,
        file_name: document.file_name,
        category: document.category,
        visibility: document.scope,
        status: document.status,
        updated_at: document.updated_at,
      }));
    return { count: documents.length, documents };
  }

  private visibleDocuments(
    context: KnowledgeToolContext,
    status: KnowledgeDocumentStatus,
    category?: KnowledgeCategoryCode | null,
  ): KnowledgeDocument[] {
    return fixture.knowledge.documents.filter(
      (document) =>
        document.status === status &&
        (document.scope === 'company' || document.owner_user_id === context.userId) &&
        (category === undefined || document.category === category),
    );
  }

  private assertTenant(context: KnowledgeToolContext): void {
    if (context.tenantId !== fixture.tenant.id) throw notFound('Knowledge tenant');
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('und');
}
