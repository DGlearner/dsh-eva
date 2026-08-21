ARG NODE_IMAGE=node:22.19.0-bookworm-slim
FROM ${NODE_IMAGE}

RUN npm install --global pnpm@11.7.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/control-plane ./services/control-plane
COPY runtimes/dsh-runner ./runtimes/dsh-runner
COPY extensions/company-dsh ./extensions/company-dsh
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/observability ./packages/observability
COPY packages/test-fixtures ./packages/test-fixtures
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @company/observability build \
  && pnpm --filter @company/dsh-extension build \
  && pnpm --filter @company/dsh-runner build \
  && pnpm --filter @company/db build \
  && pnpm --filter @company/control-plane build
USER 10001:10001
CMD ["node", "services/control-plane/dist/main.js"]
