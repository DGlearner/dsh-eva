import type {
  KnowledgeCategoryCode,
  KnowledgeDocumentStatus,
  KnowledgeScope,
  UUID,
} from '../domain/models.js';

export interface KnowledgeToolContext {
  tenantId: UUID;
  userId: UUID;
}

export interface KnowledgeSearchItem {
  document_id: UUID;
  knowledge_id: string;
  version: number;
  title: string;
  file_name: string;
  category: KnowledgeCategoryCode | null;
  visibility: KnowledgeScope;
  heading_path: string[];
  content: string;
  line_start: number;
  line_end: number;
  score: number;
  vector_score: number | null;
  lexical_score: number | null;
}

export interface KnowledgeToolDocument {
  document_id: UUID;
  knowledge_id: string;
  version: number;
  title: string;
  file_name: string;
  category: KnowledgeCategoryCode | null;
  visibility: KnowledgeScope;
  status: KnowledgeDocumentStatus;
  updated_at: string;
}

export interface KnowledgeToolPort {
  getCurrentUser(context: KnowledgeToolContext): {
    user_id: UUID;
    tenant_id: UUID;
    username: string;
    display_name: string;
  };
  search(
    context: KnowledgeToolContext,
    input: { query: string; category?: KnowledgeCategoryCode | null; top_k?: number },
  ): { query: string; count: number; results: KnowledgeSearchItem[] };
  listDocuments(
    context: KnowledgeToolContext,
    input: {
      status?: KnowledgeDocumentStatus;
      category?: KnowledgeCategoryCode | null;
      limit?: number;
    },
  ): { count: number; documents: KnowledgeToolDocument[] };
}
