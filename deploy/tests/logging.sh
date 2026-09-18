#!/bin/sh
# shellcheck disable=SC3040 # bash and Alpine ash both implement pipefail.
# shellcheck disable=SC2016 # greps match literal ${VAR} fragments in sources.
# Integration tests for deploy/syslog-ng/{syslog-ng.conf,rotate.sh}.
# Uses disposable containers with unique names. Cleanup touches only those names.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
CONF="${ROOT}/deploy/syslog-ng/syslog-ng.conf"
ROTATE="${ROOT}/deploy/syslog-ng/rotate.sh"
# Pinned collector image from the nodes stack. Local cache, no pull of latest.
COLLECTOR_IMAGE="linuxserver/syslog-ng:4.11.0"
ALPINE_IMAGE="alpine:3.22"

RUN_ID="rll${$}$(date +%s)"
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")
CONTAINERS=""

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

cleanup() {
	status=$?
	set +e
	for name in ${CONTAINERS}; do
		docker rm -f "${name}" >/dev/null 2>&1
	done
	rm -rf "${WORKDIR}"
	exit "${status}"
}
trap cleanup EXIT INT TERM

host_udp_port() {
	container=$1
	docker inspect -f '{{(index (index .NetworkSettings.Ports "5514/udp") 0).HostPort}}' "${container}"
}

wait_file_contains() {
	file=$1
	needle=$2
	timeout_s=${3:-15}
	i=0
	while [ "${i}" -lt "${timeout_s}" ]; do
		if [ -f "${file}" ] && grep -Fq "${needle}" "${file}"; then
			return 0
		fi
		i=$((i + 1))
		sleep 1
	done
	if [ -f "${file}" ]; then
		printf 'file contents:\n%s\n' "$(cat "${file}")" >&2
	fi
	fail "timed out waiting for ${needle} in ${file}"
}

emit_raw() {
	port=$1
	payload=$2
	python3 -c '
import socket, sys
port = int(sys.argv[1])
payload = sys.argv[2]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    sock.sendto(("<30>Sep 13 10:00:00 host quip-cpu: " + payload).encode(), ("127.0.0.1", port))
finally:
    sock.close()
' "${port}" "${payload}"
}

EMIT_N=0

next_name() {
	prefix=$1
	EMIT_N=$((EMIT_N + 1))
	printf '%s-%s-%s' "${RUN_ID}" "${prefix}" "${EMIT_N}"
}

emit_docker() {
	port=$1
	tag=$2
	message=$3
	name=$(next_name emit)
	remember_container "${name}"
	docker run --name "${name}" --rm --pull=never \
		--log-driver syslog \
		--log-opt "syslog-address=udp://127.0.0.1:${port}" \
		--log-opt "tag=${tag}" \
		"${ALPINE_IMAGE}" \
		sh -c 'printf "%s\n" "$1"' _ "${message}" >/dev/null
}

emit_bulk() {
	port=$1
	tag=$2
	marker=$3
	count=${4:-60}
	name=$(next_name bulk)
	remember_container "${name}"
	docker run --name "${name}" --rm --pull=never \
		--log-driver syslog \
		--log-opt "syslog-address=udp://127.0.0.1:${port}" \
		--log-opt "tag=${tag}" \
		"${ALPINE_IMAGE}" \
		sh -c 'i=1; while [ "$i" -le "$1" ]; do printf "%s line %s padding-padding-padding\n" "$2" "$i"; i=$((i + 1)); done' _ "${count}" "${marker}" >/dev/null
}

assert_file() {
	file=$1
	needle=$2
	what=$3
	grep -Fq "${needle}" "${file}" || fail "${what}: missing ${needle} in ${file}
$(cat "${file}")"
}

log "== static contract on syslog-ng.conf"
text=$(cat "${CONF}")
printf '%s' "${text}" | grep -Fq 'port(5514)' || fail "UDP 5514"
printf '%s' "${text}" | grep -Fq 'udp(ip("0.0.0.0")' || fail "bind 0.0.0.0"
printf '%s' "${text}" | grep -Fq 'so-rcvbuf(8388608)' || fail "so-rcvbuf"
printf '%s' "${text}" | grep -Fq '/logs/quip-node.log' || fail "log path"
printf '%s' "${text}" | grep -Fq 'owner(`PUID`)' || fail "PUID owner"
printf '%s' "${text}" | grep -Fq 'group(`PGID`)' || fail "PGID group"
printf '%s' "${text}" | grep -Fq 'perm(0644)' || fail "perm 0644"
printf '%s' "${text}" | grep -Fq -- "--no-ctrl-chars" || fail "sanitize --no-ctrl-chars"
printf '%s' "${text}" | grep -Fq "invalid-chars '\\n\\r'" || fail "sanitize CR/LF single-quoted"
printf '%s' "${text}" | grep -Fq 'log { source(s_net); destination(d_merged); }' || fail "log statement"
if printf '%s' "${text}" | grep -Fq 'internal();'; then
	fail "internal(); source would loop collector diagnostics"
fi
printf '%s' "${text}" | grep -Fq '@version: 4.2' || fail "@version 4.2"

log "== static contract on rotate.sh"
[ -x "${ROTATE}" ] || fail "rotate.sh must be executable"
head -n 1 "${ROTATE}" | grep -Fxq '#!/bin/bash' || fail "Bash collector wrapper"
grep -Fq 'set -eu' "${ROTATE}" || fail "set -eu"
# rotate.sh uses the short form `set -euo pipefail` (the `-eu` grep above
grep -Fq 'set -euo pipefail' "${ROTATE}" || fail "set -o pipefail"
grep -Fq 'QUIP_LOG_MAX_BYTES:-10485760' "${ROTATE}" || fail "default 10 MiB"
grep -Fq 'QUIP_LOG_KEEP:-5' "${ROTATE}" || fail "default KEEP 5"
grep -Fq 'QUIP_LOG_CHECK_INTERVAL:-30' "${ROTATE}" || fail "default interval 30"
grep -Fq 'stat -c %s' "${ROTATE}" || fail "size-based rotation"
grep -Fq 'kill -HUP' "${ROTATE}" || fail "SIGHUP reopen"
grep -F 'mv "${LOG}.${i}" "${LOG}.$((i + 1))"' "${ROTATE}" || fail "increment archive index"
grep -F 'rm -f "${LOG}.${KEEP}"' "${ROTATE}" || fail "drop oldest"
grep -F 'mv "${LOG}" "${LOG}.1"' "${ROTATE}" || fail "rename live file"
grep -F 'sleep "${INTERVAL}" &' "${ROTATE}" || fail "background sleep"
grep -F 'wait "${SLP}"' "${ROTATE}" || fail "interruptible wait"
grep -F 'kill "${SLP}"' "${ROTATE}" || fail "stop kills sleep"
grep -Fq 'elif [ "${SEEN}" -eq 1 ]' "${ROTATE}" || fail "deleted-file recovery"
grep -Fq 'require_positive_int' "${ROTATE}" || fail "integer validation"
grep -Fq 'exit 1' "${ROTATE}" || fail "nonzero unexpected child failure"

log "== syslog-ng syntax (--syntax-only, --pull=never)"
syntax_name="${RUN_ID}-syntax"
remember_container "${syntax_name}"
docker run --name "${syntax_name}" --rm --pull=never --entrypoint syslog-ng \
	-e PUID=1000 -e PGID=1000 \
	-v "${CONF}:/config/syslog-ng.conf:ro" \
	"${COLLECTOR_IMAGE}" \
	--syntax-only -f /config/syslog-ng.conf

log "== invalid KEEP/MAX/INTERVAL must not delete files"
sentinel="${WORKDIR}/invalid"
mkdir -p "${sentinel}"
printf 'live\n' >"${sentinel}/quip-node.log"
printf 'one\n' >"${sentinel}/quip-node.log.1"
printf 'keep-me\n' >"${sentinel}/keep-me"
run_invalid() {
	name=$1
	shift
	remember_container "${name}"
	if docker run --name "${name}" --rm --pull=never \
		--entrypoint /rotate.sh \
		-v "${ROTATE}:/rotate.sh:ro" \
		-v "${CONF}:/config/syslog-ng.conf:ro" \
		-v "${sentinel}:/logs" \
		"$@" \
		"${COLLECTOR_IMAGE}"; then
		fail "${name} should have exited nonzero"
	fi
}
run_invalid "${RUN_ID}-bad-keep" -e QUIP_LOG_KEEP=abc -e PUID=0 -e PGID=0
run_invalid "${RUN_ID}-bad-keep0" -e QUIP_LOG_KEEP=0 -e PUID=0 -e PGID=0
run_invalid "${RUN_ID}-bad-max" -e QUIP_LOG_MAX_BYTES=nope -e PUID=0 -e PGID=0
run_invalid "${RUN_ID}-bad-int" -e QUIP_LOG_CHECK_INTERVAL=0 -e PUID=0 -e PGID=0
[ -f "${sentinel}/quip-node.log" ] || fail "invalid KEEP deleted live log"
[ -f "${sentinel}/quip-node.log.1" ] || fail "invalid KEEP deleted archive"
[ -f "${sentinel}/keep-me" ] || fail "invalid KEEP deleted unrelated file"
grep -Fxq 'live' "${sentinel}/quip-node.log" || fail "live log rewritten"
grep -Fxq 'one' "${sentinel}/quip-node.log.1" || fail "archive rewritten"

start_collector() {
	name=$1
	logs_dir=$2
	shift 2
	mkdir -p "${logs_dir}"
	remember_container "${name}"
	docker run -d --name "${name}" --pull=never \
		--entrypoint /rotate.sh \
		-e "PUID=$(id -u)" \
		-e "PGID=$(id -g)" \
		-e QUIP_LOG_MAX_BYTES=4096 \
		-e QUIP_LOG_CHECK_INTERVAL=2 \
		-e QUIP_LOG_KEEP=5 \
		-p "127.0.0.1::5514/udp" \
		-v "${CONF}:/config/syslog-ng.conf:ro" \
		-v "${ROTATE}:/rotate.sh:ro" \
		-v "${logs_dir}:/logs" \
		"$@" \
		"${COLLECTOR_IMAGE}" >/dev/null
}

log "== collector sanitization, tags, ownership"
COLLECT="${RUN_ID}-collect"
LOGS="${WORKDIR}/logs"
start_collector "${COLLECT}" "${LOGS}"
PORT=$(host_udp_port "${COLLECT}")
emit_docker "${PORT}" "readiness-probe" "probe-ok"
wait_file_contains "${LOGS}/quip-node.log" "probe-ok" 20

emit_docker "${PORT}" "quip-cpu" "validators=ws://quip-validator:9944 dir=/data/logs"
emit_raw "${PORT}" "$(printf '2026/08/16 05:22:02.881\tERROR\thttp.log.error\tconnection refused')"
emit_raw "${PORT}" "$(printf 'safe\n2026-09-13T00:00:00+00:00 quip-validator FORGED-LINE')"
# Literal n and r must survive (the double-quoted "\n\r" regression rewrote them).
emit_raw "${PORT}" "round connection refused"
sleep 2
merged="${LOGS}/quip-node.log"
assert_file "${merged}" "ws://quip-validator:9944 dir=/data/logs" "slashes"
assert_file "${merged}" "$(printf '05:22:02.881\tERROR\thttp.log.error')" "tabs"
assert_file "${merged}" "safe_2026-09-13T00:00:00+00:00 quip-validator FORGED-LINE" "CR/LF sanitization"
assert_file "${merged}" "round connection refused" "literal n/r"
if grep -E ' quip-validator ' "${merged}" | grep -vq 'FORGED-LINE'; then
	:
fi
programs=$(awk '{ print $2 }' "${merged}" | sort -u)
if printf '%s\n' "${programs}" | grep -Fxq 'quip-validator'; then
	fail "newline injection forged program tag:
${programs}
$(cat "${merged}")"
fi
oct=$(stat -c %a "${merged}")
[ "${oct}" = "644" ] || fail "mode ${oct}, expected 644"
[ "$(stat -c %u "${merged}")" = "$(id -u)" ] || fail "uid mismatch"
[ "$(stat -c %g "${merged}")" = "$(id -g)" ] || fail "gid mismatch"

emit_docker "${PORT}" "quip-miner" "attempt submitted"
emit_docker "${PORT}" "quip-validator" "block imported"
emit_docker "${PORT}" "quip-caddy" "request served"
sleep 2
assert_file "${merged}" "quip-miner attempt submitted" "miner tag"
assert_file "${merged}" "quip-validator block imported" "validator tag"
assert_file "${merged}" "quip-caddy request served" "caddy tag"
miner_at=$(awk '/quip-miner attempt submitted/{ print NR; exit }' "${merged}")
val_at=$(awk '/quip-validator block imported/{ print NR; exit }' "${merged}")
caddy_at=$(awk '/quip-caddy request served/{ print NR; exit }' "${merged}")
[ "${miner_at}" -lt "${val_at}" ] && [ "${val_at}" -lt "${caddy_at}" ] || fail "merge order ${miner_at} ${val_at} ${caddy_at}"

log "== rotation by size, KEEP=5, not by time"
emit_docker "${PORT}" "quip-miner" "tiny-line-under-threshold"
sleep 8
if [ -f "${LOGS}/quip-node.log.1" ]; then
	fail "rotated on interval without exceeding size"
fi
round=1
while [ "${round}" -le 7 ]; do
	emit_bulk "${PORT}" "quip-miner" "round-${round}" 60
	sleep 4
	round=$((round + 1))
done
sleep 2
[ -f "${LOGS}/quip-node.log" ] || fail "live file missing after rotation"
[ -f "${LOGS}/quip-node.log.1" ] || fail "missing .1"
[ -f "${LOGS}/quip-node.log.2" ] || fail "missing .2"
[ -f "${LOGS}/quip-node.log.3" ] || fail "missing .3"
[ -f "${LOGS}/quip-node.log.4" ] || fail "missing .4"
[ -f "${LOGS}/quip-node.log.5" ] || fail "missing .5"
if [ -f "${LOGS}/quip-node.log.6" ]; then
	fail "KEEP=5 must drop .6"
fi
emit_docker "${PORT}" "quip-caddy" "post-rotate-alive"
wait_file_contains "${LOGS}/quip-node.log" "post-rotate-alive" 10

log "== deleted active file recovery"
emit_docker "${PORT}" "quip-miner" "before-delete"
wait_file_contains "${LOGS}/quip-node.log" "before-delete" 10
rm -f "${LOGS}/quip-node.log"
if [ -f "${LOGS}/quip-node.log" ]; then
	fail "unlink failed"
fi
i=0
recreated=0
while [ "${i}" -lt 12 ]; do
	emit_docker "${PORT}" "quip-miner" "after-delete"
	if [ -f "${LOGS}/quip-node.log" ]; then
		recreated=1
		break
	fi
	i=$((i + 1))
	sleep 1
done
[ "${recreated}" = 1 ] || fail "supervisor did not recreate the live log"
size_after=$(stat -c %s "${LOGS}/quip-node.log")
emit_docker "${PORT}" "quip-miner" "still-growing"
sleep 2
[ "$(stat -c %s "${LOGS}/quip-node.log")" -gt "${size_after}" ] || fail "recreated file is not growing"
assert_file "${LOGS}/quip-node.log" "still-growing" "writes after recreate"

log "== unexpected syslog-ng death is nonzero"
CRASH="${RUN_ID}-crash"
remember_container "${CRASH}"
docker run -d --name "${CRASH}" --pull=never \
	--entrypoint /rotate.sh \
	-e QUIP_LOG_CHECK_INTERVAL=30 \
	-e PUID=0 -e PGID=0 \
	-v "${CONF}:/config/syslog-ng.conf:ro" \
	-v "${ROTATE}:/rotate.sh:ro" \
	"${COLLECTOR_IMAGE}" >/dev/null
sleep 2
sng_pid=$(docker exec "${CRASH}" pidof syslog-ng | awk '{ print $1 }')
[ -n "${sng_pid}" ] || fail "syslog-ng not running in crash fixture"
docker exec "${CRASH}" kill -9 "${sng_pid}"
i=0
exit_code=""
while [ "${i}" -lt 5 ]; do
	running=$(docker inspect -f '{{.State.Running}}' "${CRASH}")
	if [ "${running}" = "false" ]; then
		exit_code=$(docker inspect -f '{{.State.ExitCode}}' "${CRASH}")
		break
	fi
	i=$((i + 1))
	sleep 1
done
[ -n "${exit_code}" ] || fail "supervisor did not exit after child death"
[ "${exit_code}" != "0" ] || fail "crashed syslog-ng reported a clean exit (${exit_code})"

log "== SIGTERM is immediate (does not wait the check interval)"
STOP="${RUN_ID}-stop"
remember_container "${STOP}"
docker run -d --name "${STOP}" --pull=never \
	--entrypoint /rotate.sh \
	-e QUIP_LOG_CHECK_INTERVAL=30 \
	-e PUID=0 -e PGID=0 \
	-v "${CONF}:/config/syslog-ng.conf:ro" \
	-v "${ROTATE}:/rotate.sh:ro" \
	"${COLLECTOR_IMAGE}" >/dev/null
sleep 3
running=$(docker inspect -f '{{.State.Running}}' "${STOP}")
[ "${running}" = "true" ] || fail "stop fixture exited before SIGTERM"
start=$(date +%s)
docker stop -t 10 "${STOP}" >/dev/null
end=$(date +%s)
elapsed=$((end - start))
[ "${elapsed}" -lt 5 ] || fail "SIGTERM ignored; docker stop took ${elapsed}s"

log "OK logging.sh"
