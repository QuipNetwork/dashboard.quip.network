#!/bin/sh
# QUI-1959: refuse to build an image whose CA bundle still trusts the forged
# eMudhra chain (parent QUI-1923).
#
# Upgrading ca-certificates is not proof by itself. A base image can be fresh
# and still ship the pre-fix bundle (eclipse-temurin:21-jre did, 2026-10-24), a
# mirror can lag, and apk/apt exit 0 when "upgrade" finds nothing newer. So
# the build checks the file the clients actually read, and fails closed.
#
# Two roots must be gone:
#   emSign ECC Root CA - G3      SHA-256 86:A1:EC:BA:08:9C:4A:8D:...:6B:BE:6B
#   AAA Certificate Services     SHA-256 D7:A7:A0:FB:5D:7E:27:31:...:69:9E:F4
#                                (it cross-signed the bad intermediates)
# Each marker is 20 base64 characters of that root's public key, the same
# windows scratch/emudhra-probe/probe.sh was calibrated on. They are placed so
# that no line break falls inside them at 60, 64, 72, 76 or 80 columns, so a
# match does not depend on how this distro wraps its PEM.
#
# An empty or missing bundle would pass a "marker absent" test trivially, so
# the certificate count is checked first.
#
# Usage: sh assert-fixed-bundle.sh /etc/ssl/certs/ca-certificates.crt
set -eu

bundle="${1:?usage: assert-fixed-bundle.sh <bundle>}"

[ -r "$bundle" ] || { echo "FATAL: no readable CA bundle at $bundle" >&2; exit 1; }

n="$(grep -c 'BEGIN CERTIFICATE' "$bundle" || true)"
[ "${n:-0}" -gt 100 ] || { echo "FATAL: $bundle holds ${n:-0} certificates, expected >100" >&2; exit 1; }

for marker in '58Byr+iuL+FBVIcUqEqy' '3M/vg4aijJRPn2jymJBG'; do
  if grep -qF -e "$marker" "$bundle"; then
    echo "FATAL: $bundle still holds the root with marker $marker" >&2
    exit 1
  fi
done

echo "trust store OK: $bundle, $n certificates, neither eMudhra root"
