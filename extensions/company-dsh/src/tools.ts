import { randomUUID } from 'node:crypto';

import type {
  KnowledgeCategory,
  KnowledgeDocumentStatus,
  KnowledgeSessionEventSink,
  KnowledgeToolContext,
  KnowledgeToolPort,
} from './types.js';

const FORBIDDEN_ARGUMENTS = new Set([
  'user_id',
  'tenant_id',
  'department_id',
  'url',
  'endpoint',
  'header',
  'headers',
  'token',
]);

function objectArguments(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tool input must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_ARGUMENTS.has(key) || !allowed.includes(key)) {
      throw new Error(`tool argument ${key} is not allowed`);
    }
  }
  return input;
}

export class CompanyKnowledgeTools {
  constructor(
    private readonly port: KnowledgeToolPort,
    private readonly context: KnowledgeToolContext,
    private readonly events: KnowledgeSessionEventSink,
  ) {}

  async execute(name: string, value: unknown): Promise<unknown> {
    const callId = randomUUID();
    const input = objectArguments(
      value,
      name === 'search_knowledge'
        ? ['query', 'category', 'top_k']
        : name === 'list_knowledge_documents'
          ? ['status', 'category', 'limit']
          : [],
    );
    this.events.append('company/tool-call', { call_id: callId, tool: name, input });
    let output: unknown;
    if (name === 'get_current_user') {
      output = await this.port.getCurrentUser(this.context);
    } else if (name === 'search_knowledge') {
      output = await this.port.searchKnowledge(this.context, {
        query: requiredString(input.query, 'query'),
        category: optionalCategory(input.category),
        topK: optionalInteger(input.top_k, 'top_k'),
      });
    } else if (name === 'list_knowledge_documents') {
      output = await this.port.listKnowledgeDocuments(this.context, {
        status: optionalString(input.status) as KnowledgeDocumentStatus | undefined,
        category: optionalCategory(input.category),
        limit: optionalInteger(input.limit, 'limit'),
      });
    } else {
      throw new Error(`knowledge tool ${name} is not registered`);
    }
    const citations =
      name === 'search_knowledge'
        ? (output as { results: Array<Record<string, unknown>> }).results.map((result) => ({
            document_id: result.document_id,
            version: result.version,
            line_start: result.line_start,
            line_end: result.line_end,
          }))
        : [];
    this.events.append('company/tool-result', { call_id: callId, tool: name, output, citations });
    return output;
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('value must be a string');
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}

function optionalCategory(value: unknown): KnowledgeCategory | undefined {
  if (value === undefined || value === null) return value;
  if (!['company-information', 'xiaopai-design', 'patent-document'].includes(String(value))) {
    throw new Error('category is invalid');
  }
  return value as KnowledgeCategory;
}
