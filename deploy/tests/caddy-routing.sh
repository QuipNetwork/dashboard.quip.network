#!/bin/sh
# shellcheck disable=SC3040 # bash and Alpine ash both implement pipefail.
# Integration tests for deploy/Caddyfile.
# Uses disposable containers with unique names. Cleanup touches only those names.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
CADDYFILE="${ROOT}/deploy/Caddyfile"
FRONTEND="${ROOT}/deploy/tests/fixtures/frontend"
DATA="${ROOT}/deploy/tests/fixtures/data"
MOCK_PY="${ROOT}/deploy/tests/fixtures/mock-upstreams.py"

# Official Caddy v2.11.4 from the local cache. Matches GitHub latest stable
# (v2.11.4, 2026-06-03). Do not pull a floating caddy:2 tag.
CADDY_IMAGE="caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"
PYTHON_IMAGE="python:3.12-slim"
ALPINE_IMAGE="alpine:3.22"

RUN_ID="rlc${$}$(date +%s)"
NET="${RUN_ID}-net"
MOCK="${RUN_ID}-mock"
CADDY="${RUN_ID}-caddy"
CURL="${RUN_ID}-curl"
TLS="${RUN_ID}-tls"
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")
CONTAINERS=""
NETWORKS=""

log() {
	printf '%s\n' "$*"
}

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

remember_container() {
	CONTAINERS="${CONTAINERS} $1"
}

remember_network() {
	NETWORKS="${NETWORKS} $1"
}

cleanup() {
	status=$?
	set +e
	for name in ${CONTAINERS}; do
		docker rm -f "${name}" >/dev/null 2>&1
	done
	for name in ${NETWORKS}; do
		docker network rm "${name}" >/dev/null 2>&1
	done
	rm -rf "${WORKDIR}"
	exit "${status}"
}
trap cleanup EXIT INT TERM

host_port() {
	container=$1
	private=$2
	docker inspect -f "{{(index (index .NetworkSettings.Ports \"${private}\") 0).HostPort}}" "${container}"
}

wait_log() {
	container=$1
	needle=$2
	i=0
	while [ "${i}" -lt 50 ]; do
		if docker logs "${container}" 2>&1 | grep -q "${needle}"; then
			return 0
		fi
		i=$((i + 1))
		sleep 0.1
	done
	docker logs "${container}" >&2 || true
	fail "container ${container} did not log: ${needle}"
}

wait_http() {
	url=$1
	i=0
	while [ "${i}" -lt 50 ]; do
		if curl -sf --max-time 1 "${url}" >/dev/null 2>&1; then
			return 0
		fi
		i=$((i + 1))
		sleep 0.1
	done
	fail "HTTP not ready: ${url}"
}

request() {
	# request METHOD URL [curl extra args...]
	# Sets STATUS, BODY, HDRS.
	method=$1
	url=$2
	shift 2
	hdrs_file="${WORKDIR}/hdrs"
	body_file="${WORKDIR}/body"
	STATUS=$(curl -sS -D "${hdrs_file}" -o "${body_file}" -w '%{http_code}' -X "${method}" "${url}" "$@")
	BODY=$(cat "${body_file}")
	HDRS=$(cat "${hdrs_file}")
}

assert_status() {
	expected=$1
	what=$2
	[ "${STATUS}" = "${expected}" ] || fail "${what}: status ${STATUS}, expected ${expected}
${HDRS}
${BODY}"
}

assert_contains() {
	haystack=$1
	needle=$2
	what=$3
	printf '%s' "${haystack}" | grep -Fq "${needle}" || fail "${what}: missing ${needle}
${haystack}"
}

assert_not_contains() {
	haystack=$1
	needle=$2
	what=$3
	printf '%s' "${haystack}" | grep -Fq "${needle}" && fail "${what}: unexpectedly contains ${needle}
${haystack}"
	return 0
}

header_value() {
	name=$1
	printf '%s\n' "${HDRS}" | awk -v n="$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]')" '
		BEGIN { FS = ":" }
		tolower($1) == n {
			sub(/^[^:]+:[[:space:]]*/, "")
			sub(/\r$/, "")
			print
			exit
		}
	'
}

# Fetch over TLS with python ssl. This host's curl build sends an internal TLS
# alert against Caddy's local issuer even though openssl and python complete the
# handshake; those clients are the reliable ones here. We only assert the page
# content, never certificate trust (CERT_NONE), so no public ACME is involved.
tls_get() {
	port=$1
	python3 -c '
from __future__ import annotations
import socket, ssl, sys
port = int(sys.argv[1])
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
s = socket.create_connection(("127.0.0.1", port), timeout=5)
ss = ctx.wrap_socket(s, server_hostname="localhost")
ss.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
data = b""
try:
	while True:
		chunk = ss.recv(65536)
		if not chunk:
			break
		data += chunk
except (socket.timeout, OSError):
	pass
ss.close()
sys.stdout.write(data.decode("utf-8", errors="replace"))
' "${port}"
}

tls_ready() {
	port=$1
	tls_get "${port}" 2>/dev/null | grep -Fq "spa-index"
}

log "== Caddyfile syntax (official Caddy v2.11.4, local digest, --pull=never)"
docker run --rm --pull=never \
	-v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
	"${CADDY_IMAGE}" \
	caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
caddy_ver=$(docker run --rm --pull=never --entrypoint caddy "${CADDY_IMAGE}" version)
log "Caddy version: ${caddy_ver}"
printf '%s\n' "${caddy_ver}" | grep -q 'v2.11.4' || fail "expected Caddy v2.11.4, got ${caddy_ver}"

log "== start mock upstreams and Caddy"
docker network create "${NET}" >/dev/null
remember_network "${NET}"

docker run -d --name "${MOCK}" --pull=never --network "${NET}" \
	-v "${MOCK_PY}:/mock-upstreams.py:ro" \
	"${PYTHON_IMAGE}" python3 /mock-upstreams.py >/dev/null
remember_container "${MOCK}"
wait_log "${MOCK}" "mock-upstreams-ready"

# Pre-create the ACME cert mount point so Docker doesn't auto-vivify it as
# root when the read-only certificates fixture below is bind-mounted inside.
mkdir -p "${WORKDIR}/caddy-data/caddy/certificates" "${WORKDIR}/caddy-config"
docker run -d --name "${CADDY}" --pull=never --network "${NET}" \
	--user "$(id -u):$(id -g)" \
	-e QUIP_HOSTNAME=:8080 \
	-e CERT_EMAIL=hostmaster@localhost \
	-e "QUIP_VALIDATOR_UPSTREAM=${MOCK}:9944" \
	-e "QUIP_MINER_UPSTREAM=${MOCK}:8086" \
	-e "QUIP_FAUCET_UPSTREAM=${MOCK}:8087" \
	-e "QUIP_DASHBOARD_UPSTREAM=${MOCK}:3001" \
	-e XDG_DATA_HOME=/data/caddy/data \
	-e XDG_CONFIG_HOME=/data/caddy/config \
	-v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
	-v "${FRONTEND}:/app/frontend:ro" \
	-v "${DATA}/qblocks:/data/qblocks:ro" \
	-v "${DATA}/miners:/data/miners:ro" \
	-v "${DATA}/nodes:/data/nodes:ro" \
	-v "${DATA}/dashboard.db:/data/dashboard.db:ro" \
	-v "${DATA}/syslog-ng:/data/syslog-ng:ro" \
	-v "${WORKDIR}/caddy-data:/data/caddy/data" \
	-v "${DATA}/caddy/data/caddy/certificates:/data/caddy/data/caddy/certificates:ro" \
	-v "${WORKDIR}/caddy-config:/data/caddy/config" \
	-p 127.0.0.1::8080 \
	"${CADDY_IMAGE}" >/dev/null
remember_container "${CADDY}"

HTTP_PORT=$(host_port "${CADDY}" "8080/tcp")
BASE="http://127.0.0.1:${HTTP_PORT}"
wait_http "${BASE}/"

log "== route precedence"
request GET "${BASE}/rpc"
assert_status 200 "/rpc"
assert_contains "${BODY}" '"upstream": "validator"' "/rpc upstream"
assert_contains "${BODY}" '"path": "/"' "/rpc rewrite to /"
assert_contains "$(header_value Cache-Control)" "no-store" "/rpc cache"

request POST "${BASE}/rpc/system"
assert_status 200 "/rpc/*"
assert_contains "${BODY}" '"upstream": "validator"' "/rpc/* upstream"
assert_contains "${BODY}" '"path": "/system"' "/rpc/* strip /rpc"

request GET "${BASE}/api/v1/status"
assert_status 200 "/api/v1/*"
assert_contains "${BODY}" '"upstream": "miner"' "/api/v1 miner"
assert_contains "${BODY}" '"path": "/api/v1/status"' "/api/v1 path kept"
assert_contains "$(header_value Cache-Control)" "no-store" "/api/v1 cache"
assert_contains "$(header_value Content-Type)" "application/json" "/api/v1 type"

request POST "${BASE}/api/faucet/request"
assert_status 200 "/api/faucet/*"
assert_contains "${BODY}" '"upstream": "faucet"' "/api/faucet faucet"
assert_contains "${BODY}" '"path": "/request"' "/api/faucet strip prefix"

request GET "${BASE}/api/health"
assert_status 200 "/api/health"
assert_contains "${BODY}" '"upstream": "dashboard"' "/api/health dashboard"
assert_contains "$(header_value Cache-Control)" "no-store" "/api/health cache"

request GET "${BASE}/api/live"
assert_status 200 "/api/live"
assert_contains "${BODY}" '"upstream": "dashboard"' "/api/live dashboard"
assert_contains "$(header_value Cache-Control)" "no-store" "/api/live cache"

log "== SPA, assets, API 404s, content types"
request GET "${BASE}/"
assert_status 200 "GET /"
assert_contains "${BODY}" "spa-index" "GET / body"
assert_contains "$(header_value Content-Type)" "text/html" "GET / type"
assert_contains "$(header_value Cache-Control)" "no-cache" "GET / revalidate"
assert_contains "$(header_value Cache-Control)" "must-revalidate" "GET / must-revalidate"

request GET "${BASE}/miners/deep/link"
assert_status 200 "SPA deep link"
assert_contains "${BODY}" "spa-index" "SPA deep link body"
assert_contains "$(header_value Content-Type)" "text/html" "SPA deep link type"

request GET "${BASE}/assets/app.deadbeef.js"
assert_status 200 "hashed asset"
assert_contains "${BODY}" "hashed-asset" "hashed asset body"
assert_contains "$(header_value Content-Type)" "javascript" "hashed asset type"
assert_contains "$(header_value Cache-Control)" "immutable" "hashed asset immutable"
assert_contains "$(header_value Cache-Control)" "max-age=31536000" "hashed asset max-age"

request GET "${BASE}/assets/missing.js"
assert_status 404 "missing asset"
assert_not_contains "${BODY}" "spa-index" "missing asset must not be SPA HTML"

request GET "${BASE}/fonts/missing.otf"
assert_status 404 "missing font"
assert_not_contains "${BODY}" "spa-index" "missing font must not be SPA HTML"

request GET "${BASE}/fonts/test.otf"
assert_status 200 "present font"
assert_contains "${BODY}" "OTTO-fixture-font" "present font body"

request GET "${BASE}/api/does-not-exist"
assert_status 404 "missing API"
assert_contains "${BODY}" '"upstream": "dashboard"' "missing API still dashboard"
assert_contains "$(header_value Content-Type)" "application/json" "missing API type"
assert_not_contains "${BODY}" "spa-index" "missing API must not be SPA HTML"

log "== /files static data (qblocks manifest)"
request GET "${BASE}/files/qblocks/metadata.json"
assert_status 200 "files manifest"
assert_contains "${BODY}" '"qblocks"' "files manifest body"
assert_contains "$(header_value Content-Type)" "application/json" "files manifest type"
assert_contains "$(header_value Cache-Control)" "public" "files manifest cacheable"

request GET "${BASE}/files/qblocks/missing.json"
assert_status 404 "missing files entry"
assert_not_contains "${BODY}" "spa-index" "missing files entry must not be SPA HTML"

request GET "${BASE}/files/miners/5GPP/status.json"
assert_status 200 "files miners entry"
assert_contains "${BODY}" '"miner":"5GPP"' "files miners entry body"
assert_contains "$(header_value Cache-Control)" "no-cache" "files miners entry revalidated"

request GET "${BASE}/files/nodes/snapshot.json"
assert_status 200 "files nodes entry"
assert_contains "${BODY}" '"nodeDescriptors"' "files nodes entry body"
assert_contains "$(header_value Cache-Control)" "no-cache" "files nodes entry revalidated"

log "== /files must not expose the private state directory"
request GET "${BASE}/files/dashboard.db"
assert_status 404 "files must not expose the index database"
assert_not_contains "${BODY}" "spa-index" "dashboard.db must not fall through to SPA HTML"

request GET "${BASE}/files/caddy/data/caddy/certificates/acme/example.com/example.com.key"
assert_status 404 "files must not expose Caddy's ACME key"
assert_not_contains "${BODY}" "spa-index" "ACME key must not fall through to SPA HTML"

request GET "${BASE}/files/syslog-ng/persist"
assert_status 404 "files must not expose syslog-ng state"
assert_not_contains "${BODY}" "spa-index" "syslog-ng state must not fall through to SPA HTML"

log "== WebSocket upgrade through /rpc"
# curl exits with code 52 when, after receiving the 101, the fixture closes
# the connection without sending any websocket frames. Validate the upgrade
# with a raw socket instead: we only need the 101 and the handshake header.
ws_out=$(python3 -c '
import base64, hashlib, socket, sys
key = "dGhlIHNhbXBsZSBub25jZQ=="
req = (
    "GET /rpc HTTP/1.1\r\n"
    "Host: 127.0.0.1:%s\r\n"
    "Connection: Upgrade\r\n"
    "Upgrade: websocket\r\n"
    "Sec-WebSocket-Version: 13\r\n"
    "Sec-WebSocket-Key: " + key + "\r\n"
    "\r\n"
) % sys.argv[1]
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
s.sendall(req.encode("ascii"))
s.settimeout(5)
data = b""
try:
    while b"\r\n\r\n" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
except socket.timeout:
    pass
s.close()
sys.stdout.write(data.decode("ascii", errors="replace"))
' "${HTTP_PORT}")
printf '%s' "${ws_out}" | grep -Fq "101 Switching Protocols" || fail "websocket /rpc: ${ws_out}"
printf '%s' "${ws_out}" | grep -Fq "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" || fail "websocket accept: ${ws_out}"

log "== internal :8088 (same routes, no self-proxy requirement)"
docker run -d --name "${CURL}" --pull=never --network "${NET}" "${ALPINE_IMAGE}" sleep 60 >/dev/null
remember_container "${CURL}"
# wget is in alpine busybox. Status is in the error message for non-2xx.
rpc8088=$(docker exec "${CURL}" wget -q -O- "http://${CADDY}:8088/rpc")
printf '%s' "${rpc8088}" | grep -Fq '"upstream": "validator"' || fail ":8088 /rpc: ${rpc8088}"
spa8088=$(docker exec "${CURL}" wget -q -O- "http://${CADDY}:8088/miners")
printf '%s' "${spa8088}" | grep -Fq "spa-index" || fail ":8088 SPA: ${spa8088}"
if docker exec "${CURL}" wget -q -O- "http://${CADDY}:8088/assets/missing.js" >/dev/null 2>&1; then
	fail ":8088 missing asset should 404"
fi

log "== private Caddy admin"
ADMIN="${RUN_ID}-admin"
docker run -d --name "${ADMIN}" --pull=never --network "container:${CADDY}" \
	"${ALPINE_IMAGE}" sleep 30 >/dev/null
remember_container "${ADMIN}"
if docker exec "${ADMIN}" wget -q -O- "http://127.0.0.1:2019/config/" >/dev/null 2>&1; then
	fail "Caddy admin must be off even on container loopback"
fi

log "== TLS with local issuer and persistent XDG state (no public ACME)"
mkdir -p "${WORKDIR}/tls-data" "${WORKDIR}/tls-config"
docker run -d --name "${TLS}" --pull=never --network "${NET}" \
	--user "$(id -u):$(id -g)" \
	-e QUIP_HOSTNAME=localhost:8443 \
	-e CERT_EMAIL=hostmaster@localhost \
	-e "QUIP_VALIDATOR_UPSTREAM=${MOCK}:9944" \
	-e "QUIP_MINER_UPSTREAM=${MOCK}:8086" \
	-e "QUIP_FAUCET_UPSTREAM=${MOCK}:8087" \
	-e "QUIP_DASHBOARD_UPSTREAM=${MOCK}:3001" \
	-e XDG_DATA_HOME=/data/caddy/data \
	-e XDG_CONFIG_HOME=/data/caddy/config \
	-v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
	-v "${FRONTEND}:/app/frontend:ro" \
	-v "${WORKDIR}/tls-data:/data/caddy/data" \
	-v "${WORKDIR}/tls-config:/data/caddy/config" \
	-p 127.0.0.1::8443 \
	"${CADDY_IMAGE}" >/dev/null
remember_container "${TLS}"
TLS_PORT=$(host_port "${TLS}" "8443/tcp")
i=0
while [ "${i}" -lt 50 ]; do
	if tls_ready "${TLS_PORT}"; then
		break
	fi
	i=$((i + 1))
	sleep 0.2
done
[ "${i}" -lt 50 ] || fail "TLS Caddy did not become ready"
tls_body=$(tls_get "${TLS_PORT}")
printf '%s' "${tls_body}" | grep -Fq "spa-index" || fail "TLS GET /: ${tls_body}"
# Confirm an internal (not ACME) certificate was stored under XDG_DATA_HOME.
find "${WORKDIR}/tls-data" -name '*.crt' | grep -q . || fail "no certificate stored under XDG_DATA_HOME"
docker stop "${TLS}" >/dev/null
docker rm "${TLS}" >/dev/null
CONTAINERS=$(printf '%s' "${CONTAINERS}" | sed "s/ ${TLS}//")
docker run -d --name "${TLS}" --pull=never --network "${NET}" \
	--user "$(id -u):$(id -g)" \
	-e QUIP_HOSTNAME=localhost:8443 \
	-e CERT_EMAIL=hostmaster@localhost \
	-e "QUIP_VALIDATOR_UPSTREAM=${MOCK}:9944" \
	-e "QUIP_MINER_UPSTREAM=${MOCK}:8086" \
	-e "QUIP_FAUCET_UPSTREAM=${MOCK}:8087" \
	-e "QUIP_DASHBOARD_UPSTREAM=${MOCK}:3001" \
	-e XDG_DATA_HOME=/data/caddy/data \
	-e XDG_CONFIG_HOME=/data/caddy/config \
	-v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
	-v "${FRONTEND}:/app/frontend:ro" \
	-v "${WORKDIR}/tls-data:/data/caddy/data" \
	-v "${WORKDIR}/tls-config:/data/caddy/config" \
	-p 127.0.0.1::8443 \
	"${CADDY_IMAGE}" >/dev/null
remember_container "${TLS}"
TLS_PORT=$(host_port "${TLS}" "8443/tcp")
i=0
while [ "${i}" -lt 50 ]; do
	if tls_ready "${TLS_PORT}"; then
		break
	fi
	i=$((i + 1))
	sleep 0.2
done
[ "${i}" -lt 50 ] || fail "TLS Caddy did not become ready after restart"
tls_body=$(tls_get "${TLS_PORT}")
printf '%s' "${tls_body}" | grep -Fq "spa-index" || fail "TLS after restart: ${tls_body}"
find "${WORKDIR}/tls-data" -name '*.crt' | grep -q . || fail "certificate missing after restart"

log "OK caddy-routing.sh"
