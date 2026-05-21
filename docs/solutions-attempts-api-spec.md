# Solutions Attempts View — API + Dashboard Spec

> Status: **proposal** — describes a future miner-side API and dashboard view. Not implemented in v0.2.

## Motivation

The current `MinerStatsPanel` on the dashboard's MyNode view surfaces aggregate counters from the miner's `/api/v1/stats` endpoint (Solutions Attempted, Solutions Computed, Heads Observed, etc.). These are useful summaries but don't let operators inspect the _characteristics_ of individual solution attempts — energy distribution, time-per-attempt, why a particular attempt didn't win, rejection reasons, submission errors.

A dedicated "Solutions Attempts" view backed by a richer miner-side API would let operators:

- Watch live attempt-by-attempt activity.
- Diagnose mining stalls (e.g., 95% of attempts ending in "stale" → upstream RPC lag).
- Validate hardware changes (does the GPU produce lower-energy solutions than the CPU?).
- Audit submission errors without tailing miner logs.

## Proposed miner API: `GET /api/v1/attempts`

Returns the most recent N solution attempts (default 100, max 1024) as a JSON array, newest first.

Query parameters:

- `limit` — number of attempts to return (1-1024, default 100).
- `since` — ISO 8601 timestamp; only return attempts that started after this time. Optional.

Each attempt record:

```json
{
  "attempt_id": "01HZ3K…",
  "started_at": "2026-05-20T14:32:08.123Z",
  "duration_ms": 4823,
  "target_head_hash": "0xab12…",
  "target_head_number": 20724,
  "result": "won",
  "energy": -2.51,
  "diversity": 0.42,
  "num_solutions_found": 5,
  "nonce": "8784943353476409907",
  "miner_id": "quip-miner-pow-CPU-1",
  "chain_block_number_landed": 20725,
  "rejection_reason": null,
  "submission_error": null
}
```

`result` values:

- `"won"` — submitted and accepted by chain; this miner's proof had the lowest energy.
- `"lost"` — submitted and accepted, but another miner's proof won the block.
- `"rejected"` — submitted; chain rejected (invalid proof, stale topology, etc.). `rejection_reason` populated.
- `"stale"` — completed locally but a new chain head arrived before submission; not submitted.
- `"in_progress"` — currently hashing; `duration_ms`, `energy`, `nonce` may be null.
- `"error"` — submission failed (network, signing). `submission_error` populated.

## Dashboard surface

A new sub-section under the MyNode view (or its own top-level tab — TBD) that:

1. **Live attempt stream** — polls `/api/v1/attempts?limit=100` every 6 seconds (matches block time). Optionally upgrades to Server-Sent Events when the miner supports it.
2. **Energy histogram** — bins recent attempts by energy with win/loss overlay so operators can visually correlate "lowest-energy attempts win."
3. **Sortable table** — virtualized list of recent attempts. Columns: started_at, duration, target block #, result (with color chip), energy, diversity, solutions_found, nonce (truncated), miner_id, rejection_reason. Sortable by every column.
4. **Cross-link** — each `"won"` row links to its on-chain block via `chain_block_number_landed`, opening the RecentBlocksTable scrolled to that row.

## Storage

- **Miner side:** ring buffer of the last 1024 attempts in memory. Optionally configurable via `--attempt-history-size`. The miner does not need to persist these across restarts.
- **Dashboard side:** no DB write — the dashboard polls the miner's endpoint directly. No new schema bump.

## Open questions

- **Retention size:** is 1024 enough for an operator's debugging window? On a node observing ~10 heads per minute, 1024 attempts ≈ 1.5 hours of history.
- **Streaming mechanism:** poll-every-6s vs. WebSocket/SSE — depends on miner architecture. Poll is simpler and matches the block cadence; SSE eliminates one round-trip per poll cycle.
- **`result="won"` source of truth:** is the BlockWinner event the authoritative signal, or does the miner mark wins internally via its `ProofAccepted` event watcher? They should agree, but reconciling reduces a class of dashboard-side correctness bugs.
- **Privacy / multi-tenant:** if the dashboard ever surfaces other miners' attempt histories (peer-query), each miner needs to control whether `/api/v1/attempts` is public or auth-gated.

## Not in scope for this spec

- Live energy-distribution chart per miner type (already exists on the Network view via aggregate stats).
- Per-attempt cryptographic verification (out of scope — chain handles this).
- Historical attempt persistence (the ring buffer is intentionally lossy; longer-term retention would use the dashboard's existing `blocks` table, which only captures won attempts).
