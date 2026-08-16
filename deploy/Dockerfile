# Build from the repository root.
#   prod (default, what CI publishes):  docker build -f deploy/Dockerfile .
#   dev  (used by docker-compose):       docker build -f deploy/Dockerfile --target dev .
#
# Stage graph: frontend (SPA build) → runtime-base (bun + tini) → dev | prod.
# tini is PID 1 in both runtime targets; deploy/entrypoint.ts is its single
# child and supervises the app processes.

# ---- frontend build stage (prod static SPA) ----
FROM oven/bun:1 AS frontend
WORKDIR /app
# The manifests are copied without bun.lock, so this stage resolves fresh
# rather than installing what CI locked. Runtime deps still float here.
COPY package.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install
# The SPA needs the shared types package + its own sources.
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
# Delegate to the workspace build script, then run the no-@polkadot bundle guard.
RUN bun run --filter @quip/frontend build
RUN bun run verify:no-polkadot-in-bundle

# ---- runtime base: tini (PID 1), shared by dev and prod ----
FROM oven/bun:1 AS runtime-base
WORKDIR /app
# The app runs entirely under bun — the entrypoint, server, indexer, migrations
# and the @polkadot substrate client all execute via `bun` (see
# deploy/entrypoint.ts), so no separate Node runtime is installed. That keeps the
# base arch-clean: apt resolves tini per-arch, so the image builds natively on
# amd64 and arm64 with no architecture-specific downloads. tini is our PID 1
# (zombie reaping + signal forwarding); ca-certificates backs runtime TLS (wss to
# the validator, outbound fetches).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && tini --version
# tini PID 1 → bun supervisor → app processes.
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "/app/deploy/entrypoint.ts"]

# ---- dev runtime (docker-compose; source bind-mounted at /app) ----
FROM runtime-base AS dev
ENV DEV=true \
    RUN_FRONTEND=true \
    PORT=3001 \
    STATIC_DIR=/app/apps/frontend/dist
# No source COPY and no install here: docker-compose bind-mounts the host
# checkout over /app and the supervisor runs `bun install` against it on start,
# so node_modules tracks the working tree. Runs as root so the (rootless-mapped)
# bind mount stays writable.
EXPOSE 3001 5173
CMD []

# ---- prod runtime (what CI builds + publishes) ----
FROM runtime-base AS prod
# Backend-only install: copy the root + backend workspace manifests (NOT the
# frontend manifest) so `bun install --production` skips the SPA's React/Vite
# dependency tree. The frontend ships as prebuilt static assets only.
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --production
# Backend source (Bun runs .ts directly) + the prebuilt SPA.
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY apps/server apps/server
COPY apps/indexer apps/indexer
COPY deploy deploy
COPY --from=frontend /app/apps/frontend/dist ./apps/frontend/dist
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
ENV PORT=3001 \
    STATIC_DIR=/app/apps/frontend/dist \
    RUN_SERVER=true \
    RUN_INDEXER=true
VOLUME /data
EXPOSE 3001
# Use bun for the healthcheck so we don't depend on wget/curl being in the image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
