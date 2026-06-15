FROM oven/bun:1 AS frontend
WORKDIR /app
COPY package.json ./
RUN bun install
# Targeted COPY so dep install stays cached when only source files change.
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN bun run build

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
COPY package.json ./
RUN bun install --production
COPY --from=frontend /app/dist ./dist
COPY indexer ./indexer
COPY server ./server
COPY api ./api
COPY src/types ./src/types
COPY docker/entrypoint.ts ./entrypoint.ts
# oven/bun:1 ships a `bun` user (uid 1000). Run as that user and give it
# ownership of the data volume so SQLite writes succeed.
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
ENV PORT=3001 \
    DB_ADAPTER=sqlite \
    SQLITE_PATH=/data/telemetry.db \
    STATIC_DIR=/app/dist
VOLUME /data
EXPOSE 3001
# Use bun for the healthcheck so we don't depend on wget/curl being in the image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
CMD ["bun", "run", "entrypoint.ts"]
