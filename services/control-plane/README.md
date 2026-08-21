# Control Plane

Provides local account authentication, opaque web Sessions and CSRF, `/me`, admin users and
departments, encrypted model configuration, audit events, Session indexing, the authenticated DSH
HTTP/WebSocket Gateway, the authenticated Business API Gateway, and the internal automation
contract stub.

Build and start:

```bash
npx -y pnpm@11.7.0 --filter @company/control-plane build
DATABASE_URL=... \
INTERNAL_SERVICE_TOKEN=... \
MODEL_SECRET_KEY_BASE64=... \
RUNNER_IDENTITY_SECRET_BASE64=... \
RUNNER_MANAGER_URL=http://127.0.0.1:8081 \
RUNNER_DATA_ROOT=/absolute/path/company-dsh-users \
BUSINESS_API_URL=http://127.0.0.1:8082 \
ACTOR_TOKEN_SECRET=at-least-32-characters-shared-with-business-api \
node services/control-plane/dist/main.js
```

Optional variables: `CONTROL_PLANE_HOST`, `CONTROL_PLANE_PORT`, `WORKBENCH_ENTRY_URL`,
`KNOWLEDGE_PROVIDER`, `ACTOR_TOKEN_ISSUER` (default `company-control-plane`), and the reserved
`REMOTE_MCP_*` settings documented under `deploy/`.

`BUSINESS_API_URL` must be an HTTP(S) origin without credentials or a path. `ACTOR_TOKEN_SECRET`
must contain at least 32 characters and must match the Business API configuration. Neither value is
logged. Browser Business API calls continue to use `company_session`; the Gateway validates the
Session and CSRF token, strips browser identity headers, and injects a request-bound Actor Token that
expires after 60 seconds.

Verify the Control Plane boundary:

```bash
npx -y pnpm@11.7.0 contracts:check
npx -y pnpm@11.7.0 --filter @company/control-plane typecheck
npx -y pnpm@11.7.0 --filter @company/control-plane test
npx -y pnpm@11.7.0 --filter @company/control-plane build
npx -y pnpm@11.7.0 lint
npx -y pnpm@11.7.0 format:check
```
