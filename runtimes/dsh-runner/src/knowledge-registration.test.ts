import { describe, expect, it } from 'vitest';

import { registerCompanyKnowledgeTools } from './knowledge-registration.js';

describe('registerCompanyKnowledgeTools', () => {
  it('registers only the three approved read-only tools', () => {
    const names: string[] = [];
    const definitions: Array<{
      parameters: Record<string, unknown>;
      output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): Array<{ type: string; text: string }>;
      };
    }> = [];
    registerCompanyKnowledgeTools({
      registry: { register: (tool) => names.push(tool.name) },
      defineTool: (definition) => {
        definitions.push(definition);
        return definition;
      },
      context: {
        tenantId: '00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000001003',
        username: 'dev_a',
        displayName: 'Dev A',
      },
      events: { append: () => undefined },
    });
    expect(names).toEqual(['get_current_user', 'search_knowledge', 'list_knowledge_documents']);
    expect(definitions[0]?.parameters).toEqual({});
    expect(definitions[1]?.parameters).toMatchObject({
      query: { type: 'string', required: true },
      category: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    });
    for (const definition of definitions) {
      const output = definition.output;
      expect(output.schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(output.render({}, { ok: true })).toEqual([
        { type: 'text', text: '{\n  "ok": true\n}' },
      ]);
    }
  });
});
