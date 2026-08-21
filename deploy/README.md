# Wave 1 local deployment

The reverse proxy exposes only Control Plane `/company-api/v1/*` and the authenticated `/chat`
Gateway. Runner Manager, PostgreSQL, Redis, and per-user DSH Runner ports remain on internal
networks. Browser cookies are terminated at Control Plane and are never forwarded to a Runner.

## Prerequisites

- Node.js 22.19 or newer in the Node 22 line
- pnpm 11.7.0
- Docker Engine with Compose
- An absolute host directory owned by uid `10001` for `RUNNER_DATA_ROOT`
- The Docker socket group id in `DOCKER_GID`
- A Node 22 Debian/glibc Runner base image; the Dockerfile defaults to
  `node:22.19.0-bookworm-slim` because the rc.7 native runtime is not supported on Alpine/musl

## Start

From the repository root:

```bash
npx -y pnpm@11.7.0 install --frozen-lockfile
docker build --build-arg NODE_IMAGE=node:22.19.0-bookworm-slim \
  -f runtimes/dsh-runner/Dockerfile -t company-dsh-runner:wave1 .
cp deploy/.env.example deploy/.env
mkdir -p /absolute/host/path/company-dsh-users
sudo chown 10001:10001 /absolute/host/path/company-dsh-users
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile ops run --rm migrate-platform
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Generate local secrets without committing them:

```bash
openssl rand -base64 32
```

Use separate values for `MODEL_SECRET_KEY_BASE64` and `RUNNER_IDENTITY_SECRET_BASE64`. Generate a
separate random `INTERNAL_SERVICE_TOKEN`. To seed the frozen test users after migration:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile ops run --rm \
  -e TEST_SEED_PASSWORD='<at-least-8-characters>' \
  migrate-platform node packages/db/dist/seed-platform.js
```

The local Gateway is available at `http://127.0.0.1:${GATEWAY_PORT:-8080}`. Build-time Runner
patch compatibility can be checked without changing the submodule:

```bash
git -C vendor/deepseek-harness apply --check ../../runtimes/dsh-runner/patches/company-web-chat-base.patch
```

`MODEL_BASE_URL_ALLOWLIST` is a comma-separated list of exact lowercase `host[:port]` authorities
that may resolve to private addresses, for example `host.docker.internal:43123`. Leave it empty for
ordinary public model endpoints. The allowlist never permits non-HTTP protocols or credentials in a
URL. `RUNNER_DATA_ROOT` must be an absolute host path writable by uid/gid `10001`; every user gets
separate configuration, Session, workspace, and storage mounts below it.

Run the non-skipping Docker P0 boundary suite from the repository root:

```bash
npx -y pnpm@11.7.0 --filter @company/core-platform-p0 test:integration
```

The suite requires a working Docker Engine and fails instead of skipping when Docker, PostgreSQL,
Redis, an image build, or a real Runner boundary is unavailable.

## Knowledge modes

`KNOWLEDGE_PROVIDER=fake` is the Wave 1 development path. `remote-mcp` is only a reserved,
fail-closed configuration slot: it requires `REMOTE_MCP_ENABLED=true`, an HTTPS URL, and a secret
reference, but no remote transport is implemented in this wave. Production mode rejects the fake
provider.

## Deferred work

- Real remote MCP/RAG transport and a production Credentials Provider
- A real DSH automation executor; `StubAutomationExecutor` is contract-test only
- Company Web and Business API routing, owned by their separate worktrees
- Multi-node Runner scheduling and centralized Session persistence
