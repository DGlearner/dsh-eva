export const KNOWLEDGE_TOOL_NAMES = [
  'get_current_user',
  'search_knowledge',
  'list_knowledge_documents',
] as const;

export type KnowledgeProviderConfig =
  | {
      provider: 'disabled';
      remoteMcpEnabled?: false;
      mcpUrl?: never;
      authSecretRef?: never;
      allowedTools?: never;
    }
  | {
      provider: 'fake';
      remoteMcpEnabled?: false;
      mcpUrl?: never;
      authSecretRef?: never;
      allowedTools?: readonly (typeof KNOWLEDGE_TOOL_NAMES)[number][];
    }
  | {
      provider: 'remote-mcp';
      remoteMcpEnabled: boolean;
      mcpUrl?: string;
      authSecretRef?: string;
      allowedTools?: readonly (typeof KNOWLEDGE_TOOL_NAMES)[number][];
    };

export function validateKnowledgeProviderConfig(
  config: KnowledgeProviderConfig,
  options: { production?: boolean } = {},
): void {
  if (config.provider === 'disabled') return;
  const allowedTools = config.allowedTools ?? KNOWLEDGE_TOOL_NAMES;
  if (
    allowedTools.length === 0 ||
    allowedTools.some((name) => !(KNOWLEDGE_TOOL_NAMES as readonly string[]).includes(name))
  ) {
    throw new Error('knowledge.allowedTools must contain only approved read-only tools');
  }
  if (config.provider === 'fake') {
    if (options.production) throw new Error('knowledge.provider=fake is forbidden in production');
    return;
  }
  if (!config.remoteMcpEnabled || !config.mcpUrl || !config.authSecretRef) {
    throw new Error(
      'remote-mcp requires remoteMcpEnabled=true, mcpUrl, and authSecretRef; fallback is forbidden',
    );
  }
  const endpoint = new URL(config.mcpUrl);
  if (endpoint.protocol !== 'https:') throw new Error('remote-mcp mcpUrl must use HTTPS');
}
