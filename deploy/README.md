# Integration Business Local Deployment

The public Nginx Gateway serves Company Web, forwards every `/company-api/v1/*` request to Control
Plane, and forwards authenticated `/chat` HTTP/WebSocket traffic to the current user's DSH Runner.
Control Plane keeps Platform routes local and exchanges the browser Session for a request-bound
Actor Token before forwarding Business routes. Business API, Runner Manager, PostgreSQL, Redis, and
Runner ports remain on internal networks.

Each dynamic Runner receives `COMPANY_AGENT_TOOL_GATEWAY_URL`, which defaults to the Control Plane
endpoint on the private Runner ingress network. This enables the DSH Agent to query the current
user's authorized requirements, tasks, and reports through Business API without exposing
`/internal*` publicly or copying business data into RAG.

## Prerequisites

- Node.js 22.19 or newer in the Node 22 line
- pnpm 11.7.0
- Docker Engine with Compose
- An absolute host directory owned by uid `10001` for `RUNNER_DATA_ROOT`
- The Docker socket group id in `DOCKER_GID`
- The prebuilt `company-dsh-runner:wave1` image for `/chat`

Generate distinct local secrets with `openssl rand -base64 32`. `ACTOR_TOKEN_SECRET` is shared only
between Control Plane and Business API. It must not reuse the model, Runner identity, or internal
service secret.

## Initialize

From the repository root:

```bash
npx -y pnpm@11.7.0 install --frozen-lockfile
docker build --build-arg NODE_IMAGE=node:22.19.0-bookworm-slim \
  -f runtimes/dsh-runner/Dockerfile -t company-dsh-runner:wave1 .
cp deploy/.env.example deploy/.env
mkdir -p /absolute/host/path/company-dsh-users
sudo chown 10001:10001 /absolute/host/path/company-dsh-users
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d postgres redis
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile ops run --rm migrate-platform
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile ops run --rm migrate-business
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile ops run --rm seed-platform
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile ops run --rm seed-business
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Migration commands are safe to repeat. The fixture seeds are development-only: Platform seed resets
the fixed users' test password, while Business seed inserts only missing fixture rows and does not
overwrite runtime business changes. Do not run either seed against a real company database.

The integrated application is available at `http://127.0.0.1:${GATEWAY_PORT:-8080}`. Company Web is
served without MSW. Browser requests cannot reach Business API directly; Nginx always enters Control
Plane first, and Business API accepts only the internal Actor Token.

## Verification

Run the real Gateway, PostgreSQL, and browser boundary after initialization:

```bash
COMPANY_WEB_LIVE_BASE_URL=http://127.0.0.1:${GATEWAY_PORT:-8080} \
COMPANY_WEB_LIVE_TEST_PASSWORD='<TEST_SEED_PASSWORD from deploy/.env>' \
npx -y pnpm@11.7.0 --filter @company/company-web test:e2e:live
```

The existing non-skipping Docker P0 suite still validates DSH HTTP/WebSocket, model, Knowledge Tool,
Session recovery, and two-user Runner isolation:

```bash
npx -y pnpm@11.7.0 --filter @company/core-platform-p0 test:integration
```

## Configuration Notes

`MODEL_BASE_URL_ALLOWLIST` is a comma-separated list of exact lowercase `host[:port]` authorities
that may resolve to private addresses, for example `host.docker.internal:43123`. Leave it empty for
ordinary public model endpoints. `RUNNER_DATA_ROOT` must be an absolute host path writable by uid/gid
`10001`; each user gets separate configuration, Session, workspace, and storage mounts below it.

`KNOWLEDGE_PROVIDER=fake` remains the default integration/development knowledge path. The development
Compose connects `AUTOMATION_PROVIDER=internal` to `AUTOMATION_EXECUTOR=model`: business automation
uses the initiating user's saved URL, model, and encrypted Key through a direct OpenAI-compatible API
request and never starts a DSH Runner. Production startup rejects fake providers. Remote MCP Runner
transport and per-user PAT binding are implemented; multi-node Runner scheduling and centralized
Session persistence remain deferred.

## Bind An Employee To Remote MCP

The Platform username should match the employee identity carried by the PAT. With the MCP entry in a
local Codex `config.toml`, run:

```bash
node deploy/scripts/provision-remote-mcp-user.mjs \
  --username wdl \
  --employee-id wdl \
  --server-name xiaopai \
  --config /absolute/path/to/config.toml
```

The active Platform user must already exist. The script reads the HTTPS endpoint and Bearer PAT,
encrypts the PAT into `platform.secrets`, updates `platform.rag_user_bindings`, and enables only
`get_current_user`, `search_knowledge`, and `list_knowledge_documents`. It never prints the PAT and
does not write it to a temporary file. Repeating the same binding does not advance configuration
versions; changing the PAT or employee binding refreshes only that employee's Runner on the next
`/chat` request. Changing the tenant endpoint or allowlist refreshes every affected Runner.

## Production Baseline Without MCP

`compose.production.yaml` is separate from the integration Compose. It uses `NODE_ENV=production`,
PostgreSQL-only business storage, Redis AOF, no fixture seed services, and explicit `disabled`
Knowledge and Automation providers. This mode is for production-like verification of login, model
configuration, DSH chat, Session history, Runner isolation, requirements, tasks, daily reports, and
the read-only system query Tool before real MCP and Automation are connected. Disabled endpoints
return `503 dependency_unavailable`; they never fall back to fixture data.

Create the private environment file and generate distinct secrets. The password embedded in
`DATABASE_URL` must be URL encoded. Do not reuse any of these secrets:

```bash
cp deploy/.env.production.example deploy/.env.production
openssl rand -base64 32
mkdir -p /srv/company-dsh/users
sudo chown 10001:10001 /srv/company-dsh/users
node deploy/scripts/check-production-config.mjs
node runtimes/dsh-runner/scripts/check-dsh-upgrade.mjs
docker build -f runtimes/dsh-runner/Dockerfile \
  -t company-dsh-runner:99f6f02f .
```

Apply only production migrations, then bootstrap the first local administrator exactly once. The
bootstrap requires an empty Platform database, stores an Argon2id hash, and forces a password change
at first login. Remove `BOOTSTRAP_ADMIN_PASSWORD` from the environment file immediately afterwards:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  up -d --wait postgres redis
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  --profile ops run --rm migrate-platform
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  --profile ops run --rm migrate-business
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  --profile bootstrap run --rm bootstrap-platform
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml up -d --build
```

The Gateway stays bound to `127.0.0.1`; a company-managed TLS ingress must proxy to it before browser
use because production cookies are `Secure`. Knowledge should remain `disabled` until its real
adapter passes contract, ACL, timeout, and recovery acceptance tests. Model automation can be enabled
with `AUTOMATION_PROVIDER=internal` and `AUTOMATION_EXECUTOR=model`; each intended model endpoint must
also pass connectivity, structured-output, timeout, and failure-path tests before rollout.

## Backup And Restore

Backups contain PostgreSQL plus every Runner Session, workspace, materialized model credential, and
storage file. Store them on an encrypted destination with access at least as restrictive as the
runtime data. Redis is intentionally excluded because Runner routing is reconciled from PostgreSQL
and Docker state.

The first implementation uses a short write-maintenance window for a cross-store-consistent
snapshot. Stop all user Runners through the admin API, then stop the public and write services. The
script refuses to continue if any of them are still running:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  stop gateway control-plane business-api runner-manager
deploy/scripts/backup-production.sh deploy/.env.production /encrypted/company-dsh-backups
```

Restore replaces the PostgreSQL database and therefore requires an explicit confirmation. It never
deletes Runner files: `RUNNER_DATA_ROOT` must already be empty, so move any existing directory aside
before an approved disaster recovery operation. Preserve the same model encryption and Runner
identity root secrets used by the backup:

```bash
deploy/scripts/restore-production.sh \
  deploy/.env.production \
  /encrypted/company-dsh-backups/20260823T120000Z \
  --confirm-replace-database
```

After restore, start the stack, open historical Sessions, run a model probe, and verify one task and
one daily report before reopening access. A backup is not considered usable until this recovery
check has succeeded on a non-production host.
