import { describe, expect, it } from 'vitest';

import { assertKnowledgeToolContractConsistency } from '../src/domain/knowledge-tool-contract.js';

describe('Knowledge Tool v1 contract', () => {
  it('keeps tool names, trusted identity inputs, and fixture citations consistent', () => {
    expect(() => assertKnowledgeToolContractConsistency()).not.toThrow();
  });
});
