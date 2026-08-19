# RAG MCP Integration Boundary

Owner: `feat/business-services`. Current work stores only contract mapping and future integration
notes. It must not copy, connect to, or modify `/Users/freshpi/Documents/freshpi-ai/rag-mcp`.

- Endpoints, headers, and credentials are deployment-owned; browser payloads never select them.
- `remoteMcpEnabled=false` is the default and remote mode never falls back silently to fake.
- The future adapter must preserve the frozen tool names and validate typed outputs before returning
  them to the Business API or Runner.
