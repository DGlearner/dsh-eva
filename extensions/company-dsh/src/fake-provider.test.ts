import { describe, expect, it } from 'vitest';

import { validateKnowledgeProviderConfig } from './config.js';
import { RunnerFakeKnowledgeProvider } from './fake-provider.js';
import { CompanyKnowledgeTools } from './tools.js';

const base = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  username: 'dev_a',
  displayName: 'Dev A',
};

describe('RunnerFakeKnowledgeProvider', () => {
  it('keeps personal search results isolated by runner context', async () => {
    const provider = new RunnerFakeKnowledgeProvider();
    const devA = { ...base, userId: '00000000-0000-4000-8000-000000001003' };
    const devB = { ...base, username: 'dev_b', userId: '00000000-0000-4000-8000-000000001004' };

    expect((await provider.searchKnowledge(devA, { query: '火星登录修复' })).results).toHaveLength(
      1,
    );
    expect((await provider.searchKnowledge(devB, { query: '火星登录修复' })).results).toEqual([]);
  });

  it('uses stable score and document ordering', async () => {
    const provider = new RunnerFakeKnowledgeProvider();
    const result = await provider.searchKnowledge(
      { ...base, userId: '00000000-0000-4000-8000-000000001003' },
      { query: '公司制度', category: 'company-information' },
    );
    expect(result.results.map((item) => item.document_id)).toEqual([
      '00000000-0000-4000-8000-000000002001',
      '00000000-0000-4000-8000-000000002002',
    ]);
  });

  it('persists tool call, result, and citations without accepting identity input', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const tools = new CompanyKnowledgeTools(
      new RunnerFakeKnowledgeProvider(),
      { ...base, userId: '00000000-0000-4000-8000-000000001003' },
      { append: (type, data) => events.push({ type, data }) },
    );
    await tools.execute('search_knowledge', { query: '火星登录修复' });
    expect(events.map((event) => event.type)).toEqual(['company/tool-call', 'company/tool-result']);
    expect(events[1]?.data.citations).toEqual([
      {
        document_id: '00000000-0000-4000-8000-000000002101',
        version: 1,
        line_start: 12,
        line_end: 16,
      },
    ]);
    await expect(
      tools.execute('search_knowledge', { query: 'x', user_id: 'other' }),
    ).rejects.toThrow('not allowed');
  });

  it('fails closed when remote-mcp is incomplete', () => {
    expect(() =>
      validateKnowledgeProviderConfig({ provider: 'remote-mcp', remoteMcpEnabled: false }),
    ).toThrow('fallback is forbidden');
    expect(() =>
      validateKnowledgeProviderConfig({ provider: 'fake' }, { production: true }),
    ).toThrow('forbidden in production');
    expect(() =>
      validateKnowledgeProviderConfig({ provider: 'disabled' }, { production: true }),
    ).not.toThrow();
  });
});
