# ---- build the web UI ----
FROM oven/bun:1 AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN bun run --cwd apps/web build

# ---- runtime: Bun + git + tar, server source + built UI ----
FROM oven/bun:1 AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONFIG_PATH=/data/config.yaml \
    TZ=Asia/Shanghai
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --filter @ease-deploy/server
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY --from=web /app/apps/web/dist apps/web/dist
COPY config.example.yaml ./
VOLUME ["/data", "/root/.bun/install/cache"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# SIGTERM → stop accepting new deployments, let running ones finish (SHUTDOWN_TIMEOUT_MS).
STOPSIGNAL SIGTERM
CMD ["bun", "apps/server/src/main.ts"]
