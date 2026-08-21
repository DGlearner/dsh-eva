# Integration Business Local Deployment

The public Nginx Gateway serves Company Web, forwards every `/company-api/v1/*` request to Control
Plane, and forwards authenticated `/chat` HTTP/WebSocket traffic to the current user's DSH Runner.
Control Plane keeps Platform routes local and exchanges the browser Session for a request-bound
Actor Token before forwarding Business routes. Business API, Runner Manager, PostgreSQL, Redis, and
Runner ports remain on internal networks.

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

`KNOWLEDGE_PROVIDER=fake` and `AUTOMATION_PROVIDER=fake` are the integration/business development
path. Production startup rejects fake providers. Remote MCP/RAG transport, production Credentials
Provider, a real DSH automation executor, multi-node Runner scheduling, and centralized Session
persistence remain deferred.
