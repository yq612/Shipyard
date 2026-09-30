# Downstream builds run on exactly these versions; bump them deliberately.
# Other node versions for individual projects: config.yaml → runtimes.node.
ARG BUN_VERSION=1.4.2
ARG NODE_VERSION=22.23.3

# ---- build the web UI ----
FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN bun run --cwd apps/web build

# ---- runtime: Bun for Shipyard, real Node.js for downstream build CLIs ----
# Without Node, `bun run build` falls back to Bun for node-shebang tools such
# as Nuxt 2, whose jiti/follow-redirects stack relies on V8 Error behaviour.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
COPY --from=web /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONFIG_PATH=/data/config.yaml \
    TZ=Asia/Shanghai
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --filter @shipyard/server
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY --from=web /app/apps/web/dist apps/web/dist
COPY config.example config.example
VOLUME ["/data", "/root/.bun/install/cache"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# SIGTERM → stop accepting new deployments, let running ones finish (SHUTDOWN_TIMEOUT_MS).
STOPSIGNAL SIGTERM
CMD ["bun", "apps/server/src/main.ts"]
