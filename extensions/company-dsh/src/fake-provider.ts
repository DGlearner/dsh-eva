import fixture from '@company/test-fixtures/fixture-v1' with { type: 'json' };

import type {
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeSearchItem,
  KnowledgeSearchResult,
  KnowledgeToolContext,
  KnowledgeToolPort,
  KnowledgeVisibility,
  ListKnowledgeDocumentsInput,
  ListKnowledgeDocumentsResult,
} from './types.js';

type FixtureDocument = (typeof fixture.knowledge.documents)[number];
type FixtureChunk = (typeof fixture.knowledge.chunks)[number];

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('und');
}

function assertRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`value must be an integer in the range ${minimum}-${maximum}`);
  }
  return resolved;
}

function visibleTo(document: FixtureDocument, userId: string): boolean {
  return document.scope === 'company' || document.owner_user_id === userId;
}

function matchesCategory(
  document: FixtureDocument,
  category: KnowledgeCategory | undefined,
): boolean {
  return category === undefined || document.category === category;
}

function toSearchItem(
  document: FixtureDocument,
  chunk: FixtureChunk,
  score?: number,
): KnowledgeSearchItem {
  return {
    document_id: document.id,
    knowledge_id: document.knowledge_id,
    version: document.version,
    title: document.title,
    file_name: document.file_name,
    category: document.category as KnowledgeCategory,
    visibility: document.scope as KnowledgeVisibility,
    heading_path: [...chunk.heading_path],
    content: chunk.content,
    line_start: chunk.line_start,
    line_end: chunk.line_end,
    score: score ?? chunk.score,
    vector_score: chunk.vector_score,
    lexical_score: chunk.lexical_score,
  };
}

function toDocument(document: FixtureDocument): KnowledgeDocument {
  return {
    document_id: document.id,
    knowledge_id: document.knowledge_id,
    version: document.version,
    title: document.title,
    file_name: document.file_name,
    category: document.category as KnowledgeCategory,
    visibility: document.scope as KnowledgeVisibility,
    status: document.status as KnowledgeDocumentStatus,
    updated_at: document.updated_at,
  };
}

export class RunnerFakeKnowledgeProvider implements KnowledgeToolPort {
  async getCurrentUser(context: KnowledgeToolContext) {
    return {
      user_id: context.userId,
      tenant_id: context.tenantId,
      username: context.username,
      display_name: context.displayName,
    };
  }

  async searchKnowledge(
    context: KnowledgeToolContext,
    input: { query: string; category?: KnowledgeCategory; topK?: number },
  ): Promise<KnowledgeSearchResult> {
    const query = normalize(input.query);
    if (query.length < 1 || query.length > 2_000) {
      throw new Error('query must contain 1-2000 characters after trimming');
    }
    const topK = assertRange(input.topK, 5, 1, 20);
    const documents = fixture.knowledge.documents.filter(
      (document) =>
        visibleTo(document, context.userId) &&
        document.status === 'ready' &&
        matchesCategory(document, input.category),
    );
    const documentById = new Map(documents.map((document) => [document.id, document]));
    const fixedCase = fixture.knowledge.query_cases.find(
      (item) =>
        item.actor_user_id === context.userId &&
        normalize(item.query) === query &&
        item.category === (input.category ?? null),
    );

    const chunks = fixedCase
      ? fixedCase.expected_document_ids.flatMap((documentId) =>
          fixture.knowledge.chunks.filter((chunk) => chunk.document_id === documentId),
        )
      : fixture.knowledge.chunks.filter((chunk) => {
          const document = documentById.get(chunk.document_id);
          if (!document) return false;
          const haystack = normalize(`${document.title} ${chunk.content}`);
          const terms = query.split(/\s+/u).filter(Boolean);
          return terms.every((term) => haystack.includes(term));
        });

    const scoreOverride =
      fixedCase && 'score_override' in fixedCase ? fixedCase.score_override : undefined;
    const results = chunks
      .flatMap((chunk) => {
        const document = documentById.get(chunk.document_id);
        return document ? [toSearchItem(document, chunk, scoreOverride)] : [];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.document_id.localeCompare(right.document_id) ||
          left.line_start - right.line_start,
      )
      .slice(0, topK);
    return { query: input.query.trim(), count: results.length, results };
  }

  async listKnowledgeDocuments(
    context: KnowledgeToolContext,
    input: ListKnowledgeDocumentsInput,
  ): Promise<ListKnowledgeDocumentsResult> {
    const limit = assertRange(input.limit, 50, 1, 100);
    const status = input.status ?? 'ready';
    const documents = fixture.knowledge.documents
      .filter(
        (document) =>
          visibleTo(document, context.userId) &&
          document.status === status &&
          matchesCategory(document, input.category),
      )
      .sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map(toDocument);
    return { count: documents.length, documents };
  }
}
