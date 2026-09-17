#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Tini starts this root-only initializer. All services then run under PUID:PGID.
set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
for name in PUID PGID; do
	value="${!name}"
	case "${value}" in
	'' | *[!0-9]* | 0*)
		printf '%s must be a positive decimal integer (got: %s)\n' "${name}" "${value}" >&2
		exit 2
		;;
	esac
done

DATA_DIR=/data
LOGS_DIR=/logs
mkdir -p "${DATA_DIR}" "${LOGS_DIR}"
chown -R "${PUID}:${PGID}" "${DATA_DIR}" "${LOGS_DIR}"
export PUID PGID
# Numeric IDs preserve the requested primary group even when this UID already
# belongs to an image account with another group. Discard supplementary groups.
exec /usr/bin/s6-setuidgid "${PUID}:${PGID}" \
	/usr/local/bin/quip-dashboard-supervisor
