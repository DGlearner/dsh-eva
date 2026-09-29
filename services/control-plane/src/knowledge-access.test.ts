import { describe, expect, it } from 'vitest';

import { MemoryPlatformRepository } from './memory-repository.js';
import { deriveRunnerConfigVersion, resolveUserKnowledgeAccess } from './knowledge-access.js';
import { SecretCipher } from './security.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001001';

describe('resolveUserKnowledgeAccess', () => {
  it('opens the active user PAT for a configured remote MCP provider', async () => {
    const repository = new MemoryPlatformRepository(tenantId);
    const cipher = new SecretCipher(Buffer.alloc(32, 7));
    repository.knowledgeProviderConfigs.set(tenantId, {
      tenantId,
      provider: 'remote-mcp',
      remoteMcpEnabled: true,
      endpoint: 'https://knowledge.example/mcp',
      allowedTools: ['get_current_user', 'search_knowledge', 'list_knowledge_documents'],
      configVersion: 2,
      version: 2,
    });
    repository.ragUserBindings.set(userId, {
      userId,
      ragEmployeeId: 'wdl',
      tokenCiphertext: cipher.seal('ragmcp_test-token'),
      tokenHint: 'oken',
      status: 'active',
      version: 1,
    });

    await expect(
      resolveUserKnowledgeAccess(repository, cipher, { tenantId, userId }),
    ).resolves.toEqual({
      config: {
        provider: 'remote-mcp',
        remoteMcpEnabled: true,
        mcpUrl: 'https://knowledge.example/mcp',
        authSecretRef: 'XIAOPAI_MCP_PAT',
        allowedTools: ['get_current_user', 'search_knowledge', 'list_knowledge_documents'],
      },
      credential: 'ragmcp_test-token',
      revision: 3,
    });
  });

  it('keeps chat available but disables knowledge for an unbound user', async () => {
    const repository = new MemoryPlatformRepository(tenantId);
    repository.knowledgeProviderConfigs.set(tenantId, {
      tenantId,
      provider: 'remote-mcp',
      remoteMcpEnabled: true,
      endpoint: 'https://knowledge.example/mcp',
      allowedTools: ['search_knowledge'],
      configVersion: 2,
      version: 2,
    });

    await expect(
      resolveUserKnowledgeAccess(repository, new SecretCipher(Buffer.alloc(32, 7)), {
        tenantId,
        userId,
      }),
    ).resolves.toEqual({ config: { provider: 'disabled' }, credential: null, revision: 2 });
  });

  it('rejects a remote provider that expands beyond the read-only tool contract', async () => {
    const repository = new MemoryPlatformRepository(tenantId);
    repository.knowledgeProviderConfigs.set(tenantId, {
      tenantId,
      provider: 'remote-mcp',
      remoteMcpEnabled: true,
      endpoint: 'https://knowledge.example/mcp',
      allowedTools: ['submit_daily_report'],
      configVersion: 2,
      version: 2,
    });

    await expect(
      resolveUserKnowledgeAccess(repository, new SecretCipher(Buffer.alloc(32, 7)), {
        tenantId,
        userId,
      }),
    ).rejects.toThrow('unapproved tool');
  });

  it('derives a monotonic aggregate Runner version from model and knowledge revisions', () => {
    expect(deriveRunnerConfigVersion({ modelConfigVersion: null, knowledgeRevision: 3 })).toBe(4);
    expect(deriveRunnerConfigVersion({ modelConfigVersion: 1, knowledgeRevision: 3 })).toBe(5);
    expect(deriveRunnerConfigVersion({ modelConfigVersion: 1, knowledgeRevision: 4 })).toBe(6);
  });
});
