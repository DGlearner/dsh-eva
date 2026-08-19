export interface ReservedRemoteKnowledgeConfig {
  provider: 'remote-mcp';
  remoteMcpEnabled: boolean;
  endpoint: URL;
  authSecretRef: string;
  allowedTools: readonly ['get_current_user', 'search_knowledge', 'list_knowledge_documents'];
}

export function assertRemoteKnowledgeDisabled(config: ReservedRemoteKnowledgeConfig): never {
  if (!config.remoteMcpEnabled) {
    throw new Error('Remote MCP knowledge is disabled by deployment policy.');
  }
  throw new Error(
    'Remote MCP transport and identity binding are reserved for the post-development integration wave.',
  );
}
