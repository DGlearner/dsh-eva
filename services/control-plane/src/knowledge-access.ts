import type { MaterializedKnowledgeConfig } from '@company/dsh-runner';

import type { PlatformRepository } from './domain.js';
import type { SecretCipher } from './security.js';

const APPROVED_REMOTE_TOOLS = new Set([
  'get_current_user',
  'search_knowledge',
  'list_knowledge_documents',
]);

export type UserKnowledgeAccess = {
  config: MaterializedKnowledgeConfig;
  credential: string | null;
  revision: number;
};

export function deriveRunnerConfigVersion(input: {
  modelConfigVersion: number | null;
  knowledgeRevision: number;
}): number {
  const modelRevision = input.modelConfigVersion === null ? 1 : input.modelConfigVersion + 1;
  const version = modelRevision + input.knowledgeRevision;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('runner configuration version is invalid');
  }
  return version;
}

export async function resolveUserKnowledgeAccess(
  repository: Pick<PlatformRepository, 'getKnowledgeProviderConfig' | 'getRagUserBinding'>,
  secretCipher: SecretCipher,
  identity: { tenantId: string; userId: string },
): Promise<UserKnowledgeAccess> {
  const provider = await repository.getKnowledgeProviderConfig(identity.tenantId);
  if (!provider || provider.provider === 'disabled') {
    return {
      config: { provider: 'disabled' },
      credential: null,
      revision: provider?.configVersion ?? 0,
    };
  }
  if (provider.provider === 'fake') {
    return { config: { provider: 'fake' }, credential: null, revision: provider.configVersion };
  }
  if (!provider.remoteMcpEnabled || !provider.endpoint) {
    throw new Error('remote-mcp knowledge provider is incomplete');
  }
  if (
    provider.allowedTools.length === 0 ||
    provider.allowedTools.some((name) => !APPROVED_REMOTE_TOOLS.has(name))
  ) {
    throw new Error('remote-mcp knowledge provider contains an unapproved tool');
  }
  const binding = await repository.getRagUserBinding(identity.userId);
  if (!binding || binding.status !== 'active') {
    return {
      config: { provider: 'disabled' },
      credential: null,
      revision: provider.configVersion + (binding?.version ?? 0),
    };
  }
  if (!binding.tokenCiphertext) {
    throw new Error('active RAG user binding has no credential');
  }
  return {
    config: {
      provider: 'remote-mcp',
      remoteMcpEnabled: true,
      mcpUrl: provider.endpoint,
      authSecretRef: 'XIAOPAI_MCP_PAT',
      allowedTools: provider.allowedTools as Array<
        'get_current_user' | 'search_knowledge' | 'list_knowledge_documents'
      >,
    },
    credential: secretCipher.open(binding.tokenCiphertext),
    revision: provider.configVersion + binding.version,
  };
}
