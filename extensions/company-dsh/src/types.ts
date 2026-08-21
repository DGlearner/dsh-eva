export const KNOWLEDGE_CATEGORIES = [
  'company-information',
  'xiaopai-design',
  'patent-document',
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number] | null;
export type KnowledgeVisibility = 'company' | 'personal';
export type KnowledgeDocumentStatus =
  'pending_review' | 'ready' | 'rejected' | 'archived' | 'pending_purge' | 'purging';

export type KnowledgeToolContext = {
  tenantId: string;
  userId: string;
  username: string;
  displayName: string;
};

export type KnowledgeSearchInput = {
  query: string;
  category?: KnowledgeCategory;
  topK?: number;
};

export type KnowledgeSearchItem = {
  document_id: string;
  knowledge_id: string;
  version: number;
  title: string;
  file_name: string;
  category: KnowledgeCategory;
  visibility: KnowledgeVisibility;
  heading_path: string[];
  content: string;
  line_start: number;
  line_end: number;
  score: number;
  vector_score: number | null;
  lexical_score: number | null;
};

export type KnowledgeSearchResult = {
  query: string;
  count: number;
  results: KnowledgeSearchItem[];
};

export type KnowledgeDocument = {
  document_id: string;
  knowledge_id: string;
  version: number;
  title: string;
  file_name: string;
  category: KnowledgeCategory;
  visibility: KnowledgeVisibility;
  status: KnowledgeDocumentStatus;
  updated_at: string;
};

export type ListKnowledgeDocumentsInput = {
  status?: KnowledgeDocumentStatus;
  category?: KnowledgeCategory;
  limit?: number;
};

export type ListKnowledgeDocumentsResult = {
  count: number;
  documents: KnowledgeDocument[];
};

export interface KnowledgeToolPort {
  getCurrentUser(context: KnowledgeToolContext): Promise<{
    user_id: string;
    tenant_id: string;
    username: string;
    display_name: string;
  }>;
  searchKnowledge(
    context: KnowledgeToolContext,
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeSearchResult>;
  listKnowledgeDocuments(
    context: KnowledgeToolContext,
    input: ListKnowledgeDocumentsInput,
  ): Promise<ListKnowledgeDocumentsResult>;
}

export interface KnowledgeSessionEventSink {
  append(type: 'company/tool-call' | 'company/tool-result', data: Record<string, unknown>): void;
}
