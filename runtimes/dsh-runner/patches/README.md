# DSH Patches

Store minimal patches against the locked DSH commit here. Every patch requires an upgrade smoke test
and a short reason in its filename or adjacent documentation.

`company-web-chat-base.patch` is the only Wave 1 upstream patch. The Runner image applies it to add
the `/chat` web/API and plugin bundle base, Company DSH title, and server-configured Company
Workbench entry. It also exposes rc.7's existing `SessionEvent.ignorable` envelope marker through
`Session.append()` so informational company Tool/citation events survive Runner replacement without
adding company types to DSH's generated event catalog. The same patch authenticates every HTTP RPC
and WebSocket upgrade with the short-lived Control Plane JWT and verifies tenant, user, Runner,
issuer, audience, request, and expiry claims against the current Runner's derived identity secret.
That verified identity is also the remote-company equivalent of DSH's loopback check for privileged
configuration RPCs; the Control Plane keeps the public method and field allowlist.

```bash
npx -y pnpm@11.7.0 dsh:check
```

`dsh-lock.json` freezes the upstream commit, tag, package version, patch, and exact patched-file scope.
To assess another checkout without changing the submodule first:

```bash
node runtimes/dsh-runner/scripts/check-dsh-upgrade.mjs /path/to/deepseek-harness-candidate
```

Passing this preflight proves only that the current patch applies. The candidate still requires the
Runner image build and Docker P0 regression before the lock may be updated.
