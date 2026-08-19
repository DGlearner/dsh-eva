# Business Migrations

Owner: `feat/business-services`. Forward-only migrations generated from `baseline/business-v1.sql`.

- Production applies numbered SQL files directly in this directory, in lexical order.
- Development and tests apply production files first, then `dev/*.sql`.
- `dev/` contains deterministic fake knowledge state only and must never run in production.
- Applied migrations are immutable; schema evolution adds a new numbered file.
