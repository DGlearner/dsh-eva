ARG NODE_IMAGE=node:22.19.0-bookworm-slim
FROM ${NODE_IMAGE} AS build

RUN npm install --global pnpm@11.7.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/company-web ./apps/company-web
COPY packages/contracts ./packages/contracts
COPY packages/test-fixtures ./packages/test-fixtures
COPY packages/ui ./packages/ui
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @company/company-web build

FROM nginx:1.27.5-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/company-web/dist /usr/share/nginx/html
EXPOSE 8080
