# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Combined production image for the Quip dashboard.
#
# Build from the repository root:
#   docker build -f deploy/Dockerfile --target prod -t quip-dashboard .
#   docker build -f deploy/Dockerfile --target dev  -t quip-dashboard-dev .
#
# Stage graph:
#   frontend (locked Bun SPA)          oven/bun:1.4.2-alpine
#   rust     (musl release binaries)   rust:1.98.1-alpine3.24
#   caddy    (pinned Caddy binary)     caddy@sha256:...
#            └─────────────────────────┐
#   prod     (runtime: syslog-ng +     linuxserver/syslog-ng:4.11.0
#             tini + supervisor)       ← merges all three stages
#
# The runtime image ships no JS runtime (no Bun/Node), no TypeScript sources,
# and no Cargo/Rust toolchain. It contains only the Rust executables, an
# official Caddy binary, syslog-ng, Tini, CA certificates, and the built SPA.
#
# PID 1 is Tini (no -g: the Rust supervisor assigns process groups itself and
# must not inherit an altered group). Tini reaps orphans and forwards signals
# to the single child: /app/deploy/entrypoint.sh, which does narrowly scoped
# root initialization then drops to the configured non-root user before
# starting quip-dashboard-supervisor.

# ---- frontend: locked Bun SPA build -----------------------------------------
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS frontend
WORKDIR /app
# Install from the lockfile only. Bun uses bun.lock to resolve the workspace.
COPY package.json bun.lock ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN bun run --filter @quip/frontend build && \
    bun run verify:no-polkadot-in-bundle

# ---- rust: musl release binaries -------------------------------------------
# dashboard-store enables Postgres through its default features. The app has
# no independent `postgres` feature alias. Both database backends stay enabled.
FROM rust:1.98.1-alpine3.24@sha256:1716b3aa042d735f4566d14dc54e8037de9d69556e2d5dd58131d93a613d173d AS rust
# Native crypto dependencies compile against the same musl ABI as production.
RUN apk add --no-cache build-base=0.5-r4 cmake=4.2.3-r0 pkgconf=2.5.1-r0
WORKDIR /build
ARG CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ ./crates/
RUN cargo build \
        --locked \
        --release \
        -p quip-dashboard \
        --bin quip-dashboard \
        --bin quip-dashboard-supervisor && \
    mkdir -p /out/bin && \
    install -m 0755 \
        target/release/quip-dashboard \
        target/release/quip-dashboard-supervisor \
        /out/bin/

# ---- caddy: pinned official binary ------------------------------------------
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
# The official Caddy stage provides /usr/bin/caddy (v2.11.4) at a pinned
# digest. Its musl runtime matches the production Alpine base.

# ---- geoip: pinned DB-IP City Lite database ---------------------------------
# Offline city lookup for the Network tab's node map. DB-IP City Lite is
# CC BY 4.0 (attribution: "IP Geolocation by DB-IP", https://db-ip.com) and
# uses the GeoIP2-City schema the backend decodes. Bump the month and the
# checksum together to refresh it.
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS geoip
ARG DBIP_CITY_LITE_MONTH=2026-09
ARG DBIP_CITY_LITE_SHA256=c5d05b35a45c3eea0cadc728c8f5ad751693d4e270529b731442172a73f05954
WORKDIR /geoip
RUN wget -q -O dbip-city-lite.mmdb.gz \
        "https://download.db-ip.com/free/dbip-city-lite-${DBIP_CITY_LITE_MONTH}.mmdb.gz" && \
    echo "${DBIP_CITY_LITE_SHA256}  dbip-city-lite.mmdb.gz" | sha256sum -c - && \
    gunzip dbip-city-lite.mmdb.gz

# ---- dev: Bun tooling and the frontend watch server -------------------------
# ./run overrides the entrypoint with bash and mounts source for one-off tasks.
# Compose pairs this watch server with the combined production backend.
FROM frontend AS dev
# The Bun Alpine stage uses Alpine 3.22 and does not include Bash.
RUN apk add --no-cache bash=5.2.37-r0
ENV DEV=true
ENTRYPOINT []
CMD ["bun", "run", "--filter", "@quip/frontend", "dev", "--host", "0.0.0.0"]

# ---- prod: combined runtime ---------------------------------------------------
# linuxserver/syslog-ng:4.11.0 is the deployed collector engine (matches the
# nodes stack and routing-logging tests) on Alpine. We override its s6-overlay
# entrypoint with Tini; the Rust supervisor starts syslog-ng itself from
# /app/deploy/syslog-ng/rotate.sh.
FROM linuxserver/syslog-ng:4.11.0@sha256:4cfb85ef5c4b2e3a4b94abcf185d12537a1d6bbaf0c95e7f9911cd6b83aedded AS prod

# Tini is PID 1. cap_net_bind_service is granted ONLY to the Caddy binary via
# a file capability, so a non-root process can bind the public low ports
# 80/443 without a privileged container or a container-wide capability add.
# libcap provides setcap/getcap. Versions pinned from the
# Alpine 3.24 package index (verified on 2026-09-16).
RUN apk add --no-cache \
        tini=0.19.0-r3 \
        ca-certificates=20260611-r0 \
        libcap=2.78-r0 \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY --from=rust /out/bin/quip-dashboard /usr/local/bin/quip-dashboard
COPY --from=rust /out/bin/quip-dashboard-supervisor /usr/local/bin/quip-dashboard-supervisor
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
# Narrowly scoped capability for the public low ports. Only Caddy (the front
# door) has it; the backend binds 127.0.0.1:3001 and never needs it.
RUN setcap cap_net_bind_service=+ep /usr/local/bin/caddy && \
    getcap /usr/local/bin/caddy

# Runtime configuration, collector rotation, and privilege initialization.
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/syslog-ng/syslog-ng.conf /config/syslog-ng.conf
COPY deploy/syslog-ng/rotate.sh /app/deploy/syslog-ng/rotate.sh
COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
COPY --from=frontend /app/apps/frontend/dist /app/frontend
COPY --from=geoip /geoip/dbip-city-lite.mmdb /usr/share/geoip/dbip-city-lite.mmdb

RUN chmod +x /app/deploy/entrypoint.sh /app/deploy/syslog-ng/rotate.sh
# Execute both real binaries during the build to catch missing interpreters
# and shared libraries before publishing the image.
RUN /usr/local/bin/quip-dashboard --help >/dev/null && \
    /usr/local/bin/quip-dashboard-supervisor --help >/dev/null

# Runtime data lives under /data (embedded DB at /data/dashboard.db, Caddy
# state at /data/caddy/...), independently of the host-mounted /logs prefix.
VOLUME ["/data"]
EXPOSE 80 443 20049 3001 5514/udp

# Default runtime user. Overridable via PUID/PGID at container start; the
# entrypoint sets the numeric uid/gid and re-chowns only the runtime dirs
# it owns. Child services run under these IDs after initialization.
ENV PUID=1000 \
    PGID=1000 \
    DATABASE_URL="" \
    QUIP_VALIDATOR_RPC_URLS="ws://quip-validator:9944" \
    QUIP_MINER_REST_URL="http://quip-miner:8086" \
    GEOIP_DB_PATH="/usr/share/geoip/dbip-city-lite.mmdb" \
    QUIP_HOSTNAME=":20049" \
    CERT_EMAIL="hostmaster@localhost" \
    XDG_DATA_HOME="/data/caddy/data" \
    XDG_CONFIG_HOME="/data/caddy/config" \
    QUIP_LOG_MAX_BYTES="10485760" \
    QUIP_LOG_KEEP="5" \
    QUIP_LOG_CHECK_INTERVAL="30"

# Docker liveness: probes the Rust backend's process/task liveness endpoint
# over HTTP. It reflects process and required-task liveness only, never a
# second database open, and never restarts the container for a temporarily
# unavailable validator (that is readiness, visible to operators).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD ["/usr/local/bin/quip-dashboard", "healthcheck"]

# Tini (PID 1) forwards signals to entrypoint.sh, which does root init then
# drops privilege and execs quip-dashboard-supervisor.
ENTRYPOINT ["/sbin/tini", "--", "/app/deploy/entrypoint.sh"]
