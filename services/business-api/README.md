# Business API

Owner: `feat/business-runtime`. Modular monolith for Knowledge, Requirements/Tasks, and Daily
Reports. The integration runtime uses PostgreSQL with deterministic fake Knowledge and Automation;
remote MCP remains disabled.

## Architecture

The dependency direction is fixed:

```text
Fastify route -> application service -> domain policy/state machine -> repository/provider port
                                                              ^
                                      fake / PostgreSQL / automation adapters
```

Routes authenticate a short-lived `aud=company-business-api` Actor Token and never read platform
web sessions or accept identity overrides from request payloads. Platform admin and organization
manager are separate roles.

## Transaction Model

`BusinessRepository.transaction()` defines the application unit of work without exposing Drizzle or
`pg` types. PostgreSQL binds every repository call in the unit of work to one transaction client.
Idempotent commands acquire a transaction-scoped advisory lock before reading the idempotency record;
business writes, history/revisions, audit, and the response record then commit or roll back together.
Optimistic version predicates decide concurrent commands that use different idempotency keys.

The fake repository serializes transactions and restores a complete state snapshot on failure. Its
one-shot failure injection covers late-write rollback paths in unit tests.

Automation providers are outside the database transaction and therefore cannot be rolled back. Every
start call uses the API idempotency key as the provider idempotency key. If provider start succeeds but
the local operation, review run, audit, or idempotency record fails, the database transaction rolls
back; retrying the same request resolves the existing provider run and recreates the local records.
Operation polling applies the local operation status and task review result in one transaction.

## Configuration

| Variable                            | Development default     | Notes                                                       |
| ----------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `NODE_ENV`                          | `development`           | `development`, `test`, or `production`                      |
| `PORT`                              | `3102`                  | Integer from 1 through 65535                                |
| `HOST`                              | `127.0.0.1`             | Set to `0.0.0.0` in the container                           |
| `ACTOR_TOKEN_SECRET`                | none                    | Required; at least 32 characters; shared with Control Plane |
| `ACTOR_TOKEN_ISSUER`                | `company-control-plane` | Expected short-lived Actor Token issuer                     |
| `BUSINESS_REPOSITORY`               | `fake`                  | `fake` or `postgres`; PostgreSQL requires `DATABASE_URL`    |
| `DATABASE_URL`                      | none                    | Required PostgreSQL URL in `postgres` mode                  |
| `AUTOMATION_PROVIDER`               | `fake`                  | `fake` or `internal`                                        |
| `INTERNAL_AUTOMATION_BASE_URL`      | none                    | Required for `internal` automation                          |
| `INTERNAL_AUTOMATION_SERVICE_TOKEN` | none                    | Required for `internal` automation                          |
| `KNOWLEDGE_PROVIDER`                | `fake`                  | `remote-mcp` is reserved and rejected; there is no fallback |

Production startup fails if the repository, Knowledge, or Automation selection is fake. Unknown
values also fail validation. `remote-mcp` is intentionally rejected in every environment until a
later integration implements it; it never falls back to fixture data.

## Database

The Business migration runner records the SHA-256 of each file in
`business.schema_migrations`, holds a PostgreSQL advisory lock, and applies every new file in its own
transaction. It refuses changed, removed, or out-of-order files. Development migrations require an
explicit flag and are rejected in production.

The fixed `fixture-v1` seed is also explicit and development/test only. It verifies that the Platform
tenant, users, departments, and memberships already match, then inserts only missing Business rows.
Replaying it does not overwrite runtime changes.

From the repository root, initialize an integration database in this order:

```bash
DATABASE_URL=postgresql://... npx -y pnpm@11.7.0 --filter @company/db migrate:platform
NODE_ENV=development BUSINESS_INCLUDE_DEV_MIGRATIONS=true DATABASE_URL=postgresql://... \
  npx -y pnpm@11.7.0 --filter @company/db migrate:business
TEST_SEED_PASSWORD=... DATABASE_URL=postgresql://... \
  npx -y pnpm@11.7.0 --filter @company/db seed:platform
NODE_ENV=development BUSINESS_ENABLE_FIXTURE_SEED=true DATABASE_URL=postgresql://... \
  npx -y pnpm@11.7.0 --filter @company/db seed:business
```

## Integration Runtime

The supported `integration/business` mode is explicit:

```text
NODE_ENV=development
BUSINESS_REPOSITORY=postgres
KNOWLEDGE_PROVIDER=fake
AUTOMATION_PROVIDER=fake
DATABASE_URL=postgresql://...
ACTOR_TOKEN_SECRET=<same value used to mint Control Plane Actor Tokens>
ACTOR_TOKEN_ISSUER=company-control-plane
HOST=0.0.0.0
PORT=3102
```

Startup performs a PostgreSQL health probe before listening. `GET /healthz` repeats that probe, so
the container health check fails if its database connection is unavailable. `SIGTERM` and `SIGINT`
stop Fastify from accepting work, drain active requests, and then close the PostgreSQL pool.

Build the image from the repository root:

```bash
docker build -f services/business-api/Dockerfile -t company-business-api:local .
```

The same image contains `packages/db/dist/migrate-business.js` and
`packages/db/dist/seed-business.js`, allowing `integration/business` to run migration and seed as
explicit one-shot services before starting the API.

## Commands

From the repository root:

```bash
npx -y pnpm@11.7.0 --filter @company/business-api run typecheck
npx -y pnpm@11.7.0 --filter @company/business-api run test
npx -y pnpm@11.7.0 --filter @company/business-api run build
npx -y pnpm@11.7.0 --filter @company/db run typecheck
npx -y pnpm@11.7.0 --filter @company/db run test
npx -y pnpm@11.7.0 --filter @company/db run build
```

PostgreSQL integration tests run only when `BUSINESS_TEST_DATABASE_URL` is explicitly set. The
database name must contain `test` and both `platform` and `business` schemas must be absent. DB and API
suites each migrate from empty, seed the fixed fixture, test real connections, then drop only the
schemas they created.

## Current Boundary

The implementation provides deterministic fake knowledge and automation plus the internal
automation HTTP client. It does not connect to the existing RAG repository and does not enable a real
DSH executor. The reserved remote knowledge adapter lives under `integrations/rag-mcp` and fails
closed until a later integration wave supplies controlled endpoint and identity binding.
