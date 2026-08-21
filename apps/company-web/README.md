# Company Web

Company Workbench is a React SPA. P0 chat remains the official DSH Web behind the `/chat` entry;
this package does not implement a second chat UI.

## Mock development

```bash
pnpm --filter @company/company-web dev
pnpm --filter @company/company-web test
pnpm --filter @company/company-web test:e2e
```

MSW is enabled by default in development and consumes
`@company/test-fixtures/fixture-v1`. Mock states are available through
`?mock=loading|empty|error|forbidden|conflict|unauthorized|unavailable`, and fixture actors through
`?as=admin|dev_manager|dev_a|dev_b`. These query parameters only affect requests while MSW is
enabled.

## Live API development

Create `apps/company-web/.env.live-api.local` with local values:

```env
COMPANY_API_PROXY_TARGET=http://127.0.0.1:8080
VITE_DSH_CHAT_URL=http://127.0.0.1:3000
```

Then run:

```bash
pnpm --filter @company/company-web dev:live-api
```

The `dev:live-api` script sets `VITE_ENABLE_MSW=false`. The browser always calls the same-origin
`/company-api/v1` path. In live mode the Vite development server proxies that path only when
`COMPANY_API_PROXY_TARGET` is explicitly set. The proxy target is server-only, must be an HTTP(S)
origin without credentials or a path, and is never included in the browser bundle. Disabling MSW
also disables every `X-Mock-*` request header.

Authentication uses the Gateway's same-origin HttpOnly session cookie. The client does not store a
session token in localStorage or sessionStorage. It restores the session and the in-memory CSRF
token through `/me` after a refresh, sends `X-CSRF-Token` on writes, clears it on logout or any 401,
and returns to `/login` when an established session expires.

The live target must be an integrated Company API Gateway: Platform routes go to Control Plane,
while knowledge, requirements, tasks, and daily-report routes go to Business API with server-side
actor-token exchange. A browser cannot call Business API directly.

## Build and deployment

```bash
pnpm --filter @company/company-web build
pnpm --filter @company/company-web preview
```

Deploy the generated `apps/company-web/dist` directory as static files. Configure reverse-proxy
locations in this order:

1. `/company-api/v1/*` to the integrated Company API Gateway.
2. The official DSH Web on its own public URL or Gateway prefix, matching the build-time
   `VITE_DSH_CHAT_URL` value.
3. All remaining paths, including the Workbench `/chat` handoff entry, to the SPA fallback.

[`spa-fallback.conf`](./spa-fallback.conf) is a minimal Nginx fallback include and must come after
the API and official DSH proxy locations. It keeps deep links such as `/workbench/tasks/:id` and
the `/chat` handoff entry on `index.html`.

## Environment variables

| Variable                   | Scope            | Default                | Purpose                                       |
| -------------------------- | ---------------- | ---------------------- | --------------------------------------------- |
| `VITE_ENABLE_MSW`          | Browser/build    | enabled in development | Set exactly `false` for live API mode.        |
| `COMPANY_API_PROXY_TARGET` | Vite server only | unset                  | Optional local live Gateway origin.           |
| `VITE_DSH_CHAT_URL`        | Browser/build    | unset                  | Official DSH Web handoff URL used by `/chat`. |

## Dependency sync required

The frozen root lockfile does not contain Radix Primitives. The core-platform owner must add the
approved Radix packages (Dialog, Toast, and Tooltip) in a lockfile synchronization commit. Until
that shared dependency lands, this branch uses accessible native controls and does not alter the
root package configuration or lockfile.

`fixture-v1` contains no model config, session, or Runner records. MSW therefore starts model
settings as unconfigured and Runner management as empty instead of inventing records.
