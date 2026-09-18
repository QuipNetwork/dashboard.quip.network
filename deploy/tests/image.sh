#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Disposable packaging checks. Full image checks require an already-built tag.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
QUIP_IMAGE="${QUIP_IMAGE:-quip-dashboard:rust-check}"
QUIP_DEV_IMAGE="${QUIP_DEV_IMAGE:-quip-dashboard:frontend-dev-check}"
RUNTIME_BASE='linuxserver/syslog-ng:4.11.0@sha256:4cfb85ef5c4b2e3a4b94abcf185d12537a1d6bbaf0c95e7f9911cd6b83aedded'
WORKDIR=$(mktemp -d)
RUN_ID="quip-image-check-$$"
CONTAINERS=()
VOLUMES=()
cleanup() {
	local status=$?
	trap - EXIT
	for name in "${CONTAINERS[@]}"; do docker rm -f "${name}" >/dev/null 2>&1 || true; done
	for name in "${VOLUMES[@]}"; do docker volume rm "${name}" >/dev/null 2>&1 || true; done
	rm -rf "${WORKDIR}"
	exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pass() { printf 'PASS: %s\n' "$*"; }
fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

shellcheck "${ROOT}/deploy/entrypoint.sh" "${ROOT}/deploy/tests/image.sh"
shfmt -d "${ROOT}/deploy/entrypoint.sh" "${ROOT}/deploy/tests/image.sh"
hadolint "${ROOT}/deploy/Dockerfile"
docker compose -f "${ROOT}/deploy/docker-compose.yml" config --quiet
docker compose -f "${ROOT}/deploy/docker-compose.yml" -f "${ROOT}/deploy/docker-compose.postgres.yml" config --quiet
pass 'shell, Dockerfile, and Compose checks'

cat >"${WORKDIR}/supervisor" <<'SUPERVISOR'
#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = "${PUID}" ]
[ "$(id -g)" = "${PGID}" ]
[ "$(id -G)" = "${PGID}" ]
printf 'data\n' >/data/permission-test
printf 'logs\n' >/logs/permission-test
[ "$(stat -c '%u:%g' /data/permission-test)" = "${PUID}:${PGID}" ]
[ "$(stat -c '%u:%g' /logs/permission-test)" = "${PUID}:${PGID}" ]
SUPERVISOR
chmod +x "${WORKDIR}/supervisor"
for ids in 12345:12346 911:12346 12345:911; do
	docker run --rm --entrypoint /bin/bash \
		--tmpfs /data --tmpfs /logs \
		-e "PUID=${ids%:*}" -e "PGID=${ids#*:}" \
		-v "${ROOT}/deploy/entrypoint.sh:/app/deploy/entrypoint.sh:ro" \
		-v "${WORKDIR}/supervisor:/usr/local/bin/quip-dashboard-supervisor:ro" \
		"${RUNTIME_BASE}" /app/deploy/entrypoint.sh
	pass "entrypoint UID:GID and writable paths ${ids}"
done
for ids in abc:1000 1000:0 0:1000; do
	if docker run --rm --entrypoint /bin/bash \
		-e "PUID=${ids%:*}" -e "PGID=${ids#*:}" \
		-v "${ROOT}/deploy/entrypoint.sh:/app/deploy/entrypoint.sh:ro" \
		"${RUNTIME_BASE}" /app/deploy/entrypoint.sh 2>/dev/null; then
		fail "invalid UID:GID accepted: ${ids}"
	fi
done
pass 'invalid IDs fail before initialization'

if docker image inspect "${QUIP_DEV_IMAGE}" >/dev/null 2>&1; then
	docker run --rm --entrypoint bash "${QUIP_DEV_IMAGE}" -lc 'bun --version; test -f /app/apps/frontend/package.json'
	dev="${RUN_ID}-frontend"
	CONTAINERS+=("${dev}")
	cp -R "${ROOT}/apps/frontend/src" "${WORKDIR}/frontend-src"
	printf 'export const watched = 1;\n' >"${WORKDIR}/frontend-src/image-watch-check.ts"
	docker run -d --name "${dev}" \
		-v "${WORKDIR}/frontend-src:/app/apps/frontend/src" \
		"${QUIP_DEV_IMAGE}" >/dev/null
	ready=0
	for _ in $(seq 1 30); do
		if docker exec "${dev}" bun -e 'const r = await fetch("http://127.0.0.1:5173/"); if (!r.ok || !(await r.text()).includes("/@vite/client")) process.exit(1)' >/dev/null 2>&1; then
			ready=1
			break
		fi
		sleep 1
	done
	[ "${ready}" = 1 ] || fail 'frontend watch server did not serve Vite'
	docker exec "${dev}" bun -e 'const r = await fetch("http://127.0.0.1:5173/src/image-watch-check.ts"); if (!r.ok || !(await r.text()).includes("watched = 1")) process.exit(1)'
	printf 'export const watched = 2;\n' >"${WORKDIR}/frontend-src/image-watch-check.ts"
	docker exec "${dev}" bun -e 'const r = await fetch("http://127.0.0.1:5173/src/image-watch-check.ts"); if (!r.ok || !(await r.text()).includes("watched = 2")) process.exit(1)'
	pass 'Bun/Bash tooling and live frontend watch server'
else
	printf 'NOT-RUN: development image %s is absent\n' "${QUIP_DEV_IMAGE}"
fi

if ! docker image inspect "${QUIP_IMAGE}" >/dev/null 2>&1; then
	printf 'NOT-RUN: combined runtime image %s is absent\n' "${QUIP_IMAGE}"
	exit 0
fi

# Executing the real programs catches libc/loader failures that file checks miss.
docker run --rm --entrypoint /bin/sh "${QUIP_IMAGE}" -ec '
  quip-dashboard --help >/dev/null
  quip-dashboard-supervisor --help >/dev/null
  caddy version
  syslog-ng --version
  for tool in bun node npm cargo rustc; do
    if command -v "$tool"; then exit 1; fi
  done
  test -z "$(find /app -name "*.ts" -o -name "*.tsx")"
  test -s /app/frontend/index.html
  test -f /config/syslog-ng.conf
  getcap /usr/local/bin/caddy | grep -q cap_net_bind_service
'
pass 'real binaries execute and production excludes development tools'

runtime="${RUN_ID}-runtime"
CONTAINERS+=("${runtime}")
for volume in "${RUN_ID}-data" "${RUN_ID}-logs"; do
	VOLUMES+=("${volume}")
	docker volume create "${volume}" >/dev/null
done
docker run -d --name "${runtime}" \
	-e PUID=12345 -e PGID=12346 \
	-e QUIP_VALIDATOR_RPC_URLS=ws://127.0.0.1:9 \
	-e QUIP_MINER_REST_URL=http://127.0.0.1:9 \
	-v "${RUN_ID}-data:/data" -v "${RUN_ID}-logs:/logs" \
	"${QUIP_IMAGE}" >/dev/null
wait_healthy() {
	for _ in $(seq 1 40); do
		if docker exec "${runtime}" quip-dashboard healthcheck >/dev/null 2>&1; then return 0; fi
		sleep 1
	done
	docker logs "${runtime}" >&2
	fail 'combined services did not become live with unreachable upstreams'
}
wait_healthy
docker exec "${runtime}" /bin/sh -ec '
  test "$(cat /proc/1/comm)" = tini
  pidof quip-dashboard-supervisor
  pidof quip-dashboard
  pidof caddy
  pidof syslog-ng
  for name in quip-dashboard-supervisor quip-dashboard caddy syslog-ng; do
    for pid in $(pidof "$name"); do
      test "$(awk "/^Uid:/ {print \$2}" /proc/$pid/status)" = 12345
      test "$(awk "/^Gid:/ {print \$2}" /proc/$pid/status)" = 12346
    done
  done
  test -s /data/dashboard.db
'
docker exec --user 12345:12346 "${runtime}" /bin/sh -ec 'printf persistent >/data/image-check; printf writable >/logs/image-check'
docker restart "${runtime}" >/dev/null
wait_healthy
docker exec --user 12345:12346 "${runtime}" /bin/sh -ec 'test "$(cat /data/image-check)" = persistent; test "$(cat /logs/image-check)" = writable; test -s /data/dashboard.db'
pass 'Tini, child identities, health, volume permissions, and restart persistence'
