# Runner Manager

This is the only company service allowed to access Docker Engine. It owns ensure/stop/reconcile,
Redis fencing leases, a fixed container resource template, and one active Runner per user. It never
publishes Runner ports and never accepts caller-provided images, commands, mounts, or limits.

Build and start:

```bash
npx -y pnpm@11.7.0 --filter @company/runner-manager build
DATABASE_URL=... REDIS_URL=... INTERNAL_SERVICE_TOKEN=... \
RUNNER_IDENTITY_SECRET_BASE64=... \
RUNNER_IMAGE=company-dsh-runner:wave1 \
RUNNER_IMAGE_VERSION=99f6f02fecdb7dff40c3fbc9470f5907c29f74ca \
RUNNER_DATA_ROOT=/absolute/path/company-dsh-users \
COMPANY_AGENT_TOOL_GATEWAY_URL=http://control-plane:8080/internal/v1/agent-tools/query-company-system \
node services/runner-manager/dist/main.js
```

The Manager injects the fixed internal Agent Tool Gateway URL and the current Runner's derived
identity key into each container. Neither value is accepted from model Tool arguments.
