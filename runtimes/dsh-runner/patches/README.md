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

```bash
git -C vendor/deepseek-harness apply --check ../../runtimes/dsh-runner/patches/company-web-chat-base.patch
```
