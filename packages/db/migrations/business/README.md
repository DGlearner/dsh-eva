# Business Migrations

Owner: `feat/business-runtime`. Forward-only migrations generated from `baseline/business-v1.sql`.

- `pnpm --filter @company/db migrate:business` applies production files in lexical order.
- `BUSINESS_INCLUDE_DEV_MIGRATIONS=true` then applies `dev/*.sql`; the runner rejects this flag when
  `NODE_ENV=production`.
- `business.schema_migrations` stores file name, SHA-256, and apply time. Re-running is a no-op.
- A session advisory lock prevents concurrent migration runners. Each migration and its history row
  commit or roll back together.
- Changed, missing, or out-of-order applied files fail startup. Never edit an applied SQL file; add a
  new numbered forward migration.
- The runner requires Platform migrations first because Business foreign keys reference Platform.

`dev/` creates only the fake Knowledge storage needed by deterministic development/test runtime. It
does not insert fixtures. Run the separate seed after both Platform and Business migrations:

```bash
NODE_ENV=development BUSINESS_ENABLE_FIXTURE_SEED=true DATABASE_URL=postgresql://... \
  pnpm --filter @company/db seed:business
```

The seed reads `@company/test-fixtures/fixture-v1`, verifies Platform identity alignment, and inserts
missing rows without replacing persisted Business state. Production and any environment other than
`development` or `test` are rejected.
