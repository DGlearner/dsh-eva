# Company DSH Extension

Contains `KnowledgeToolPort`, the deterministic `RunnerFakeKnowledgeProvider`, and the three
read-only tools `get_current_user`, `search_knowledge`, and `list_knowledge_documents`. Identity is
always supplied by trusted Runner context; Tool arguments cannot carry user, tenant, endpoint,
Header, or Token values. Search call/result events and citations are appended to the owning DSH
Session.

The `remote-mcp` slot is disabled by default and fails startup unless explicitly enabled with an
HTTPS endpoint and secret reference. Wave 1 does not contact a real RAG service.
