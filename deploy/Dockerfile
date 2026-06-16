# Build from the repository root:  docker build -f deploy/Dockerfile .
# ---- frontend build stage ----
FROM oven/bun:1 AS frontend
WORKDIR /app
# Copy every workspace manifest first so dep install stays cached when only
# source files change.
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
# Invoke vite via bunx so it resolves the installed binary whether bun hoisted it
# to the root or the package's node_modules (`bun run` from a workspace only puts
# the root .bin on PATH). Then run the no-@polkadot bundle guard from the root.
RUN cd apps/frontend && bunx vite build
RUN bun run verify:no-polkadot-in-bundle

# ---- runtime stage ----
FROM oven/bun:1 AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json \
         | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(JSON.parse(d).find(x=>x.version.startsWith("v24."))?.version??"")})')" \
    && test -n "$NODE_VER" \
    && curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && apt-get purge -y curl xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
    && node -v
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
COPY deploy/entrypoint.ts deploy/entrypoint.ts
COPY --from=frontend /app/apps/frontend/dist ./apps/frontend/dist
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
ENV PORT=3001 \
    STATIC_DIR=/app/apps/frontend/dist
VOLUME /data
EXPOSE 3001
# Use bun for the healthcheck so we don't depend on wget/curl being in the image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
CMD ["bun", "run", "deploy/entrypoint.ts"]
