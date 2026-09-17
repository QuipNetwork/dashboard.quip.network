#!/bin/bash
# Collector supervisor: runs syslog-ng and rotates /logs/quip-node.log.
#
# Ported from nodes.quip.network syslog-ng/entrypoint.sh at
# e4de2d6215a066dc308bc9359b6f2f510ae7caa0
# sha256:37712935ebc4618b308b6c7eab80899441a0e02db4939bd4ee18257bc3e6d93f
#
# The Rust supervisor starts this script as a child. It is not PID 1 in the
# combined image. Diagnostics stay on stderr and must not be forwarded to
# UDP 5514 (that would loop collector output back into the merged file).
#
# Why a supervisor rather than cron: syslog-ng OSE has no size-based rotation,
# and the linuxserver image's s6/crond path is not used here.
# Bash wait -n observes collector failure while the rotation timer runs.
set -euo pipefail

LOG=/logs/quip-node.log
CONF=/config/syslog-ng.conf
MAX_BYTES="${QUIP_LOG_MAX_BYTES:-10485760}" # 10 MB, matching v0.1 node_log
KEEP="${QUIP_LOG_KEEP:-5}"
INTERVAL="${QUIP_LOG_CHECK_INTERVAL:-30}"

# Reject non-integers and zero before any rotate() call. Alpine ash treats a
# non-numeric KEEP as 0 in $((KEEP - 1)), which would skip the archive loop
# and still rename the live file; a glob or path in KEEP could also name the
# wrong rm/mv target.
require_positive_int() {
	name=$1
	value=$2
	case ${value} in
	'' | *[!0-9]* | 0*)
		printf '%s must be a positive decimal integer without leading zeros (got %s)\n' "${name}" "${value}" >&2
		exit 1
		;;
	esac
}

require_positive_int QUIP_LOG_MAX_BYTES "${MAX_BYTES}"
require_positive_int QUIP_LOG_KEEP "${KEEP}"
require_positive_int QUIP_LOG_CHECK_INTERVAL "${INTERVAL}"

# The bind mount can be created root-owned by Docker on a fresh install
# (before syslog-ng ever writes to it), which leaves a non-root operator
# unable to create archive-* directories or remove rotated logs under it.
# Guarded so a failure here (e.g. PUID/PGID unset) cannot abort startup.
chown "${PUID:-0}:${PGID:-0}" /logs 2>/dev/null || true

# The configured service user owns /data; /run belongs to the image user.
mkdir -p /data/syslog-ng
COLLECTOR=(syslog-ng -F -f "${CONF}"
	--persist-file /data/syslog-ng/persist
	--pidfile /data/syslog-ng/pid
	--control /data/syslog-ng/control)
"${COLLECTOR[@]}" &
SNG=$!

RUNNING=1
SLP=""
# The trap MUST kill the backgrounded sleep as well. POSIX sh does not run
# traps while a foreground sleep blocks, so a plain `sleep $INTERVAL` here
# makes the container ignore SIGTERM until docker SIGKILLs it 10s later,
# discarding whatever syslog-ng still holds in its output buffer.
stop() {
	RUNNING=0
	# Child may already have exited; that is expected during shutdown.
	kill -TERM "${SNG}" 2>/dev/null || true
	if [ -n "${SLP}" ]; then
		kill "${SLP}" 2>/dev/null || true
	fi
}
trap stop TERM INT

# Rename-then-SIGHUP, not copytruncate: syslog-ng holds an open descriptor at
# a byte offset, so truncating in place leaves a sparse hole the size of the
# old log. SIGHUP makes syslog-ng reopen the path and create a fresh file.
rotate() {
	rm -f "${LOG}.${KEEP}"
	i=$((KEEP - 1))
	while [ "${i}" -ge 1 ]; do
		if [ -f "${LOG}.${i}" ]; then
			mv "${LOG}.${i}" "${LOG}.$((i + 1))"
		fi
		i=$((i - 1))
	done
	mv "${LOG}" "${LOG}.1"
	# HUP of an already-exiting child is expected; death is detected below.
	kill -HUP "${SNG}" || true
}

# Set once the file has been observed to exist, so the very first iteration
# (before syslog-ng has received a line and created the file) does not read
# as a deletion and trigger a needless respawn.
SEEN=0

while [ "${RUNNING}" -eq 1 ] && kill -0 "${SNG}" 2>/dev/null; do
	if [ -e "${LOG}" ]; then
		SEEN=1
		if [ "$(stat -c %s "${LOG}")" -ge "${MAX_BYTES}" ]; then
			rotate
		fi
	elif [ "${SEEN}" -eq 1 ]; then
		# The path was unlinked (e.g. `rm data/logs/quip-node.log`) while
		# syslog-ng still holds the old inode open, so it keeps writing to
		# nothing the filesystem shows and rotation can never fire again.
		# SIGHUP does not recover this -- only reopening the process does.
		kill -TERM "${SNG}" 2>/dev/null || true
		wait "${SNG}" 2>/dev/null || true
		"${COLLECTOR[@]}" &
		SNG=$!
	fi
	# Wake for either collector death or the rotation timer. Signal traps also
	# interrupt this wait, so shutdown does not wait for the timer.
	sleep "${INTERVAL}" &
	SLP=$!
	wait -n "${SNG}" "${SLP}" 2>/dev/null || true
	# Collector death or shutdown can leave the timer running. Reap it too.
	kill "${SLP}" 2>/dev/null || true
	wait "${SLP}" 2>/dev/null || true
	SLP=""
done

wait "${SNG}" 2>/dev/null || true

# RUNNING is only cleared by the TERM/INT trap. If the loop above exited any
# other way, syslog-ng died on its own. A plain exit 0 would misreport that
# as a clean stop.
if [ "${RUNNING}" -eq 1 ]; then
	exit 1
fi
