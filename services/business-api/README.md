# Business API

Owner: `feat/business-services`. Modular monolith for Knowledge, Requirements/Tasks, and Daily
Reports. The first implementation uses frozen fake providers and fixtures.

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

| Variable                            | Development default     | Notes                                                    |
| ----------------------------------- | ----------------------- | -------------------------------------------------------- |
| `PORT`                              | `3102`                  | HTTP listen port                                         |
| `HOST`                              | `127.0.0.1`             | HTTP listen host                                         |
| `ACTOR_TOKEN_SECRET`                | development-only value  | Must be at least 32 characters                           |
| `ACTOR_TOKEN_ISSUER`                | `company-control-plane` | Expected JWT issuer                                      |
| `BUSINESS_REPOSITORY`               | `fake`                  | `fake` or `postgres`; PostgreSQL requires `DATABASE_URL` |
| `AUTOMATION_PROVIDER`               | `fake`                  | `fake` or `internal`                                     |
| `INTERNAL_AUTOMATION_BASE_URL`      | none                    | Required for `internal` automation                       |
| `INTERNAL_AUTOMATION_SERVICE_TOKEN` | none                    | Required for `internal` automation                       |
| `KNOWLEDGE_PROVIDER`                | `fake`                  | Remote MCP is reserved and intentionally not enabled yet |

Production startup fails if any fake provider is selected. There is no silent fallback from a
future remote provider to fake.

## Database

Apply `packages/db/migrations/business/*.sql` in lexical order after platform migrations. Development
and tests then apply `packages/db/migrations/business/dev/*.sql`; production must never apply `dev/`.
Applied migration files are immutable and future changes add a new numbered migration.

## Commands

From the repository root:

```bash
npx -y pnpm@11.7.0 --filter @company/business-api run typecheck
npx -y pnpm@11.7.0 --filter @company/business-api run test
npx -y pnpm@11.7.0 --filter @company/business-api run build
```

PostgreSQL integration tests run only when `BUSINESS_TEST_DATABASE_URL` is explicitly set. The
database name must contain `test` and both `platform` and `business` schemas must be absent. The suite
creates and commits its schemas so concurrent connections can exercise real locking, then drops only
the schemas it created before closing the pool.

## Current Boundary

The implementation provides deterministic fake knowledge and automation plus the internal
automation HTTP client. It does not connect to the existing RAG repository and does not enable a real
DSH executor. The reserved remote knowledge adapter lives under `integrations/rag-mcp` and fails
closed until a later integration wave supplies controlled endpoint and identity binding.
