# Flux deployment: quipindexer

This branch (`deploy/flux`) holds the Flux spec for the public aglais indexer
and telemetry API. It is deploy packaging only: the image is the one upstream CI
publishes for a release tag, pinned by digest, with no local changes.

- App: `quipindexer`, 1 instance, non-enterprise
- URL: <https://indexer.aglais.quip.network/> (a CNAME to
  `quipindexer.app.runonflux.io`, which also answers). It serves `/api/*`
  (CORS `*`), `/files/*` (no CORS header) and the full dashboard at `/`.
- Spec: [`indexer-app-spec.json`](indexer-app-spec.json). The copy exported
  from the Flux dashboard is canonical. If the two differ, the export wins.

## Settings that are not obvious

- `QUIP_MINER_REST_URL=http://127.0.0.1:9`. This deployment has no miner, and
  the poller cannot be turned off, so this makes every poll fail at once. Each
  poll logs two `local miner … unavailable` WARN lines; they are expected.
- `QUIP_HOSTNAME=:20049`. Caddy serves plain HTTP; Flux's proxy (FDM)
  terminates TLS. Caddy must never try ACME here.
- `/api/health` always returns 503 with `no recent successful miner poll`,
  because there is no miner. Check liveness with `/api/live`. To see indexing
  progress, compare `lastCommittedHeight` in the `/api/health` body with the
  chain's finalized head.
- The indexer only works against an archive node. All three aglais bootnodes
  are archive nodes. The URL list is only a failover at startup: after binding,
  the indexer reconnects to the same bootnode until the process restarts.

## Data

`/data` holds the embedded Turso database, the qblock files and Caddy state.
Every row in it is derived from the chain.

- Upgrading means bumping `repotag` (always `tag@sha256:digest`). That is a
  soft redeploy and keeps `/data`.
- **Never change `hdd`.** Changing it is a hard redeploy that wipes `/data`.
- A relocation to a new node also starts with an empty `/data`. The indexer
  rebuilds its index on its own; see the timing below.

## Rebuild timing (measured locally against aglais, 2026-09-29)

Measured from a box ~0.25 s round trip from the bootnodes. Almost every step
is a chain of sequential RPC calls, so on a Flux node in Europe, next to
bootnode-3, each phase should be several times faster.

| From an empty `/data` | Local |
| --- | --- |
| Bound to aglais, current height in `/api/telemetry` | 14 s |
| All 708 miners in `chainMiners` | 2 min |
| All 649 nodes (567 with a country, 42 countries) | 10 min |
| Winner / participation / difficulty history (8,169 qblocks at 384k) | ~20 qblocks/min, latency bound; capped at 1/s |

Authorship counts in `validators` start at the first block this instance sees;
they are not backfilled.

Memory stayed at 150–190 MiB and CPU near 1% of a core. Disk extrapolates to
roughly 0.5 GB once history is complete, plus ~20 MB a day, so `hdd: 20` lasts
years.

⚠ **The indexer re-reads all node descriptors 15 min after the previous pass
ends, and live commits wait until it finishes.** That pass is ~2,000
sequential RPC calls. Locally the two passes took 8.5 and 10 min. During the
second, `lastCommittedHeight` and `chainHead` in `/api/telemetry` froze
outright, ~100 blocks behind, then caught up in one step. The spec places the
app in Europe and reads bootnode-3 first to keep that pass short. The
indexing-lag monitor in observe allows for a short one.
