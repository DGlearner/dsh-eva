# Company Web

Owner: `feat/company-web`. This package owns the Company Workbench only; P0 chat remains the
official DSH Web behind `/chat`.

## Development

```bash
pnpm --filter @company/company-web dev
pnpm --filter @company/company-web test
pnpm --filter @company/company-web test:e2e
```

MSW is enabled by default in development and consumes `@company/test-fixtures/fixture-v1`. Set
`VITE_ENABLE_MSW=false` when integrating with the real `/company-api/v1` Gateway. The `/chat`
handoff reads `VITE_DSH_CHAT_URL`; without it the development bridge shows the ready state but does
not navigate away from the Workbench.

Mock state coverage can be exercised with `?mock=loading|empty|error|forbidden|conflict`. A fixture
actor can be selected in development with `?as=admin|dev_manager|dev_a|dev_b`.

## Dependency sync required

The frozen root lockfile does not contain Radix Primitives. The core-platform owner must add the
approved Radix packages (Dialog, Toast, and Tooltip) in a lockfile synchronization commit. Until
that shared dependency lands, this branch uses accessible native controls and does not alter the
root package configuration or lockfile.

`fixture-v1` contains no model config, session, or Runner records. MSW therefore starts model
settings as unconfigured and Runner management as empty instead of inventing records.
