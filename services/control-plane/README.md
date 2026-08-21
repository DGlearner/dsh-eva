# Control Plane

Provides local account authentication, opaque web Sessions and CSRF, `/me`, admin users and
departments, encrypted model configuration, audit events, Session indexing, the authenticated DSH
HTTP/WebSocket Gateway, and the internal automation contract stub.

Build and start:

```bash
npx -y pnpm@11.7.0 --filter @company/control-plane build
DATABASE_URL=... \
INTERNAL_SERVICE_TOKEN=... \
MODEL_SECRET_KEY_BASE64=... \
RUNNER_IDENTITY_SECRET_BASE64=... \
RUNNER_MANAGER_URL=http://127.0.0.1:8081 \
RUNNER_DATA_ROOT=/absolute/path/company-dsh-users \
node services/control-plane/dist/main.js
```

Optional variables: `CONTROL_PLANE_HOST`, `CONTROL_PLANE_PORT`, `WORKBENCH_ENTRY_URL`,
`KNOWLEDGE_PROVIDER`, and the reserved `REMOTE_MCP_*` settings documented under `deploy/`.
