# Control Plane

Provides local account authentication, opaque web Sessions and CSRF, `/me`, admin users and
departments, encrypted model configuration, audit events, Session indexing, the authenticated DSH
HTTP/WebSocket Gateway, the authenticated Business API Gateway, and the internal automation
contract stub. The internal Agent Tool Gateway maps a Runner-authenticated, read-only system query
to the same Business API and authorization policies used by Company Web.

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
`KNOWLEDGE_PROVIDER`, and `ACTOR_TOKEN_ISSUER` (default `company-control-plane`). Runtime Knowledge
selection comes from `platform.knowledge_provider_configs`; per-user RAG identity and the encrypted
PAT reference come from `platform.rag_user_bindings` and `platform.secrets`.

`BUSINESS_API_URL` must be an HTTP(S) origin without credentials or a path. `ACTOR_TOKEN_SECRET`
must contain at least 32 characters and must match the Business API configuration. Neither value is
logged. Browser Business API calls continue to use `company_session`; the Gateway validates the
Session and CSRF token, strips browser identity headers, and injects a request-bound Actor Token that
expires after 60 seconds.

`POST /internal/v1/agent-tools/query-company-system` is available only on the Runner ingress
network. It accepts frozen requirement, task, personal daily-report, and manager department-report
queries. Runner identity, user, tenant, and department are server-bound; the request cannot supply
identity, URL, headers, tokens, or write operations. Public Nginx returns 404 for `/internal*`.

Use `deploy/scripts/provision-remote-mcp-user.mjs` to bind an existing active Platform username to
the matching RAG employee PAT from a local Codex `config.toml`. The script encrypts the PAT with
`MODEL_SECRET_KEY_BASE64`, is safe to repeat with unchanged input, and never prints the credential.
Model, tenant Knowledge, and user binding revisions are combined into the Runner configuration
version; a changed PAT is materialized and the old Runner is replaced on the next chat request.

`AUTOMATION_EXECUTOR` accepts `model`, `stub`, or `disabled`. `model` reads the initiating user's
encrypted model configuration, decrypts the API Key only for the outbound request, and calls the
configured OpenAI-compatible `/chat/completions` endpoint directly. It does not start or use a DSH
Runner. Prompts and strict output validation cover requirement splits, task reviews, and daily-report
rewrites. Development defaults to `stub`; production defaults to `disabled` and rejects `stub`
explicitly. The disabled executor returns a 503 instead of fabricating automation results.

Verify the Control Plane boundary:

```bash
npx -y pnpm@11.7.0 contracts:check
npx -y pnpm@11.7.0 --filter @company/control-plane typecheck
npx -y pnpm@11.7.0 --filter @company/control-plane test
npx -y pnpm@11.7.0 --filter @company/control-plane build
npx -y pnpm@11.7.0 lint
npx -y pnpm@11.7.0 format:check
```
