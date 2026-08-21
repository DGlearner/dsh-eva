ARG NODE_IMAGE=node:22.19.0-bookworm-slim
FROM ${NODE_IMAGE}

RUN npm install --global pnpm@11.7.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/business-api ./services/business-api
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/observability ./packages/observability
COPY packages/test-fixtures ./packages/test-fixtures
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @company/db build \
  && pnpm --filter @company/business-api build

ENV HOST=0.0.0.0 PORT=3102
USER 10001:10001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "services/business-api/dist/server.js"]
