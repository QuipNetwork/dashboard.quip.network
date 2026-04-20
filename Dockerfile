FROM oven/bun:1 AS frontend
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY --from=frontend /app/dist ./dist
COPY indexer ./indexer
COPY server ./server
COPY api ./api
COPY src/types ./src/types
COPY docker/entrypoint.ts ./entrypoint.ts
ENV PORT=3001 \
    DB_ADAPTER=sqlite \
    SQLITE_PATH=/data/telemetry.db \
    STATIC_DIR=/app/dist
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q -O - http://localhost:${PORT}/api/health || exit 1
CMD ["bun", "run", "entrypoint.ts"]
