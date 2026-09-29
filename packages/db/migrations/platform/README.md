# Platform Migrations

Owner: `feat/core-platform`. Forward-only migrations generated from `baseline/platform-v1.sql`.

After applying Platform migrations to a new production database, run the one-shot
`packages/db/dist/bootstrap-platform.js` command. It takes tenant and administrator identity from
`BOOTSTRAP_*`, hashes the initial password with Argon2id, sets `must_change=true`, and succeeds only
when both `platform.tenants` and `platform.users` are empty. It never updates an existing account.
The bootstrap also creates an explicit `knowledge_provider_configs` row in `disabled` mode; only the
development fixture seed changes that row to `fake`.
