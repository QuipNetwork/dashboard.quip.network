# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Flux image for the public aglais indexer (app quipindexer): the upstream CI
# release, with only its trust store refreshed.
#
# Build from deploy/flux:
#   docker build --platform linux/amd64 --provenance=false --sbom=false -t <tag> .
#
# v0.2.3-rc5 pins ca-certificates=20260611-r0, which still trusts emSign ECC
# Root CA - G3 and the AAA root that cross-signed the forged eMudhra
# intermediates. quip-dashboard's validator (jsonrpsee, wss) and miner
# (reqwest) clients verify through rustls-platform-verifier, which reads this
# OS store on Linux, and so does Caddy. So the store is the whole fix: the
# binaries, entrypoint and SPA stay the release's, byte for byte.
#
# The build checks the files themselves, not apk's exit code: the bundle by
# the vendored assert, and every file under the two certificate dirs by
# marker. -R follows the hashed symlinks, and -s drops errors from dangling
# ones, so the test is "no output".
#
# Drop this file once an upstream release ships the fixed package.
FROM registry.gitlab.com/quip.network/dashboard.quip.network:v0.2.3-rc5@sha256:4534e3474d10a03509124cfd31132d50c84d94db7e9e7357fdb856c27efd5b65

COPY trust-store/assert-fixed-bundle.sh /tmp/assert-fixed-bundle.sh
# Exact versions and no --upgrade: --upgrade would also move every dependency
# (it took musl r2 -> r3), and this layer is meant to touch the store alone.
RUN apk add --no-cache \
        ca-certificates=20261020-r0 \
        ca-certificates-bundle=20261020-r0 \
    && sh /tmp/assert-fixed-bundle.sh /etc/ssl/certs/ca-certificates.crt \
    && left="$(grep -RlsF -e '58Byr+iuL+FBVIcUqEqy' -e '3M/vg4aijJRPn2jymJBG' /etc/ssl/certs /usr/share/ca-certificates || true)" \
    && { [ -z "$left" ] || { echo "FATAL: eMudhra root still in: $left" >&2; exit 1; }; } \
    && rm /tmp/assert-fixed-bundle.sh
