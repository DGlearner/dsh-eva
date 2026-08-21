ARG NODE_IMAGE=node:22.19.0-bookworm-slim
FROM ${NODE_IMAGE} AS company-build

RUN npm install --global pnpm@11.7.0
WORKDIR /company
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY extensions/company-dsh ./extensions/company-dsh
COPY runtimes/dsh-runner/package.json runtimes/dsh-runner/tsconfig.json runtimes/dsh-runner/tsconfig.build.json ./runtimes/dsh-runner/
COPY runtimes/dsh-runner/src ./runtimes/dsh-runner/src
COPY runtimes/dsh-runner/dsh-plugin ./runtimes/dsh-runner/dsh-plugin
COPY runtimes/dsh-runner/company-runner.overlay.yml ./runtimes/dsh-runner/company-runner.overlay.yml
COPY packages/contracts ./packages/contracts
COPY packages/test-fixtures ./packages/test-fixtures
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @company/dsh-extension build \
  && pnpm --filter @company/dsh-runner build

FROM ${NODE_IMAGE} AS build

RUN if command -v apt-get >/dev/null; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential cmake git python3 \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      apk add --no-cache build-base cmake git python3; \
    fi
RUN npm install --global pnpm@11.7.0
WORKDIR /source
COPY vendor/deepseek-harness ./vendor/deepseek-harness
WORKDIR /source/vendor/deepseek-harness
RUN rm -f .git \
  && git init --quiet \
  && pnpm install --frozen-lockfile --config.node-linker=hoisted
COPY runtimes/dsh-runner/patches/company-web-chat-base.patch /tmp/company-web-chat-base.patch
COPY runtimes/dsh-runner/scripts/link-dsh-workspace.mjs /tmp/link-dsh-workspace.mjs
RUN git apply /tmp/company-web-chat-base.patch \
  && pnpm --config.node-linker=hoisted build \
  && node /tmp/link-dsh-workspace.mjs

FROM ${NODE_IMAGE} AS runtime

RUN if command -v groupadd >/dev/null; then \
       groupadd --gid 10001 dsh \
       && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin dsh; \
     else \
       addgroup -g 10001 dsh \
       && adduser -D -u 10001 -G dsh -s /sbin/nologin dsh; \
     fi
WORKDIR /opt/dsh
COPY --from=build --chown=dsh:dsh /source/vendor/deepseek-harness /opt/dsh
COPY --from=company-build --chown=dsh:dsh /company/extensions/company-dsh/package.json /opt/dsh/apps/cli/node_modules/@company/dsh-extension/package.json
COPY --from=company-build --chown=dsh:dsh /company/extensions/company-dsh/dist /opt/dsh/apps/cli/node_modules/@company/dsh-extension/dist
COPY --from=company-build --chown=dsh:dsh /company/runtimes/dsh-runner/package.json /opt/dsh/apps/cli/node_modules/@company/dsh-runner/package.json
COPY --from=company-build --chown=dsh:dsh /company/runtimes/dsh-runner/dist /opt/dsh/apps/cli/node_modules/@company/dsh-runner/dist
COPY --from=company-build --chown=dsh:dsh /company/packages/test-fixtures/package.json /opt/dsh/apps/cli/node_modules/@company/test-fixtures/package.json
COPY --from=company-build --chown=dsh:dsh /company/packages/test-fixtures/fixture-v1.json /opt/dsh/apps/cli/node_modules/@company/test-fixtures/fixture-v1.json
COPY --from=company-build --chown=dsh:dsh /company/runtimes/dsh-runner/dsh-plugin/company-knowledge-plugin.mjs /opt/dsh/apps/cli/company-knowledge-plugin.mjs
COPY --from=company-build --chown=dsh:dsh /company/runtimes/dsh-runner/company-runner.overlay.yml /opt/dsh/company-runner.overlay.yml
USER 10001:10001
ENV NODE_ENV=production DSH_HOME=/dsh-user
EXPOSE 3000
# rc.7 mounts its profile-patch watcher after boot and requires Node's internal loader hooks.
CMD ["node", "--expose-internals", "/opt/dsh/apps/cli/lib/bin.js", "web", "--patch", "/opt/dsh/company-runner.overlay.yml"]
