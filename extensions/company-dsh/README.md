# Company DSH Extension

Contains `KnowledgeToolPort`, the deterministic `RunnerFakeKnowledgeProvider`, and the three
read-only tools `get_current_user`, `search_knowledge`, and `list_knowledge_documents`. Identity is
always supplied by trusted Runner context; Tool arguments cannot carry user, tenant, endpoint,
Header, or Token values. Search call/result events and citations are appended to the owning DSH
Session.

The `remote-mcp` slot is disabled by default and fails startup unless explicitly enabled with an
HTTPS endpoint and per-user secret reference. When enabled, the Runner loads the official
`@deepseek-ai/dsh-mcp-client`; the local plugin limits execution to the configured read-only tool
allowlist.

The explicit `disabled` provider is allowed in production-like verification. It registers no local
Knowledge tools, while the separately authenticated `query_company_system` Tool remains available.
An unbound or revoked RAG user keeps chat available with Knowledge disabled. A bound user receives
only that user's PAT in the private Runner environment; Tool arguments cannot override identity,
endpoint, headers, or credentials.
