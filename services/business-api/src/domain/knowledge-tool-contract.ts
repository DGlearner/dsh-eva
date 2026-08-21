import knowledgeToolSchema from '@company/contracts/knowledge-tool-schema' with { type: 'json' };
import fixture from '@company/test-fixtures/fixture-v1' with { type: 'json' };

const expectedTools = ['get_current_user', 'list_knowledge_documents', 'search_knowledge'] as const;
const forbiddenInputFields = new Set([
  'user_id',
  'tenant_id',
  'department_id',
  'url',
  'endpoint',
  'header',
  'headers',
  'token',
]);

interface JsonSchema {
  'x-company-tools'?: Record<string, { input?: string; output?: string }>;
  $defs?: Record<string, { properties?: Record<string, unknown> }>;
}

interface KnowledgeFixture {
  knowledge: {
    documents: Array<{ id: string; version: number; status: string }>;
    chunks: Array<{
      document_id: string;
      heading_path: string[];
      content: string;
      line_start: number;
      line_end: number;
      score: number;
      vector_score: number | null;
      lexical_score: number | null;
    }>;
    query_cases: Array<{ expected_document_ids: string[] }>;
  };
}

export function assertKnowledgeToolContractConsistency(): void {
  const schema = knowledgeToolSchema as JsonSchema;
  const tools = Object.keys(schema['x-company-tools'] ?? {}).sort();
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Knowledge tool names differ from the frozen contract: ${tools.join(', ')}`);
  }
  for (const toolName of expectedTools) {
    const definition = schema['x-company-tools']?.[toolName];
    if (definition?.input === undefined || definition.output === undefined) {
      throw new Error(`Knowledge tool ${toolName} is missing input or output references.`);
    }
    const inputName = definition.input.replace('#/$defs/', '');
    const properties = Object.keys(schema.$defs?.[inputName]?.properties ?? {});
    for (const property of properties) {
      if (forbiddenInputFields.has(property)) {
        throw new Error(`Knowledge tool ${toolName} accepts forbidden identity field ${property}.`);
      }
    }
  }

  const data = fixture as unknown as KnowledgeFixture;
  const documents = new Map(data.knowledge.documents.map((document) => [document.id, document]));
  for (const chunk of data.knowledge.chunks) {
    const document = documents.get(chunk.document_id);
    if (document === undefined || document.version < 1) {
      throw new Error(`Knowledge chunk references missing document ${chunk.document_id}.`);
    }
    if (
      chunk.heading_path.length === 0 ||
      chunk.content.length === 0 ||
      chunk.line_start < 1 ||
      chunk.line_end < chunk.line_start ||
      chunk.score < 0 ||
      chunk.score > 1
    ) {
      throw new Error(`Knowledge chunk for ${chunk.document_id} violates the tool output schema.`);
    }
  }
  for (const queryCase of data.knowledge.query_cases) {
    for (const documentId of queryCase.expected_document_ids) {
      if (documents.get(documentId)?.status !== 'ready') {
        throw new Error(`Query case references non-ready document ${documentId}.`);
      }
    }
  }
}
