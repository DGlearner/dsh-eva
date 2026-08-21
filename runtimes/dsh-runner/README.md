# DSH Runner

Contains the Runner image, fixed `company` Agent preset, local Knowledge Tool assembly, secure
per-user configuration materializer, and version-bound Web patch. The submodule is pinned to
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` and must not be edited directly.

The Runner uses `DSH_HOME=/dsh-user`, uid/gid `10001`, a read-only root filesystem, dropped Linux
capabilities, no-new-privileges, resource limits, and no published host port. Model credentials are
stored only in the current user's mode `0600` bind mount. Each dynamic Runner joins an internal
ingress network for Control Plane traffic and a separate bridge egress network for model requests;
neither network publishes the Runner port and the Runner never receives the Docker socket.
Runners sharing the ingress network cannot call each other's RPC or WebSocket endpoints: the root
identity secret is never mounted into a Runner, and each container receives a distinct derived key
that only validates JWTs addressed to its tenant, user, and Runner id.

The image defaults to `node:22.19.0-bookworm-slim`. Keep production overrides on Node 22 with
Debian/glibc: the locked rc.7 native runtime crashes on Alpine/musl. The direct Node entrypoint uses
`--expose-internals` because rc.7's profile patch watcher requires its internal loader hooks.
