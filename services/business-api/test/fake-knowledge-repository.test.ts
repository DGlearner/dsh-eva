import { describe, expect, it } from 'vitest';

import { FakeKnowledgeRepository } from '../src/adapters/fake/fake-knowledge-repository.js';
import { DEV_A, DEV_B, TENANT } from './helpers.js';

describe('FakeKnowledgeRepository', () => {
  const repository = new FakeKnowledgeRepository();

  it('uses trusted context and never backfills another user personal result', () => {
    const devA = repository.search(
      { tenantId: TENANT, userId: DEV_A },
      { query: '火星登录修复', category: null },
    );
    const devB = repository.search(
      { tenantId: TENANT, userId: DEV_B },
      { query: '火星登录修复', category: null },
    );
    expect(devA.results.map((item) => item.document_id)).toEqual([
      '00000000-0000-4000-8000-000000002101',
    ]);
    expect(devB.results).toEqual([]);
  });

  it('keeps frozen tie ordering stable and defaults list status to ready', () => {
    const search = repository.search(
      { tenantId: TENANT, userId: DEV_A },
      { query: '公司制度', category: 'company-information' },
    );
    expect(search.results.map((item) => item.document_id)).toEqual([
      '00000000-0000-4000-8000-000000002001',
      '00000000-0000-4000-8000-000000002002',
    ]);
    expect(search.results.every((item) => item.score === 0.7)).toBe(true);
    expect(
      repository
        .listDocuments({ tenantId: TENANT, userId: DEV_A }, {})
        .documents.every((item) => item.status === 'ready'),
    ).toBe(true);
  });
});
