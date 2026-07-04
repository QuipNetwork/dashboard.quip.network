// SPDX-License-Identifier: AGPL-3.0-or-later

export type MinerCategory = "CPU" | "GPU" | "QPU" | "OTHER";

export type MinerHardwareSource = "self" | "peer-query" | "chain";

/**
 * Per-miner hardware inventory. v0.3 only ever writes a single row with
 * source='self' from the locally polled quip-node; peer-query and chain
 * surfaces are reserved for later versions when the miner exposes peer
 * inventories or the chain pallet publishes hardware metadata.
 */
export interface MinerHardwareRecord {
  accountId: string;
  nodeId: string;
  miners: Array<{ id: string; type: MinerCategory }>;
  // Dominant type across `miners[]`, derived by the writer (not the source).
  primaryType: MinerCategory;
  source: MinerHardwareSource;
  observedAt: string;
}

/**
 * Aggregate counters from `/api/v1/stats` on the locally polled quip-miner.
 * Mirrors the upstream `controller` sub-object — the miner deprecated its
 * top-level totals (total_blocks_attempted / total_blocks_won / win_rate /
 * total_mining_time / avg_mining_time) in favor of these pipeline counters,
 * so the dashboard derives display aggregates from them (Submission Rate)
 * or from chain BlockRecords (Avg Mining Time).
 */
export interface MinerStats {
  headsObserved: number;
  contextsDispatched: number;
  // Total dispatches that produced a result (= proofsSubmitted +
  // proofsUnverified). The right upper bound for the indexer's
  // mining_submissions catch-up — `proofsSubmitted` skips
  // chain-rejected submissions (outcome=chain_error), leaving them
  // un-indexed.
  resultsReceived: number;
  proofsSubmitted: number;
  staleDrops: number;
  submissionErrors: number;
  // Results the miner produced but then discarded because they
  // duplicated a prior solution (same hash, same head). Visible on the
  // dashboard so operators can explain a `resultsReceived` >
  // `proofsSubmitted` gap without shelling into the miner. 0 for legacy
  // observability rows persisted before this field landed.
  duplicateResultDrops: number;
}

/**
 * Per-backend slice of the aggregated container snapshot. In a
 * single-process container `modes` is `{}` (no breakdown needed); in
 * a multi-process container (one quip-miner per active backend group)
 * there's one entry per active mode keyed by `cpu` / `gpu` / `qpu`.
 *
 * The aggregator sibling assembles this by reading each child's
 * `telemetry-stats-<kind>.json` and bucketing under its `mode` field
 * before merging the top-level counters. Operators reading the
 * dashboard see the unified numbers AND the per-backend breakdown
 * for "is the qpu doing anything?" investigations.
 */
export interface ModeBreakdown {
  // Subset of MinerStats counters that survive the per-process split
  // — only what the snapshot's `controller` block carries (pool /
  // chain heartbeat counters are container-wide and aggregated out
  // of this slice).
  headsObserved: number;
  contextsDispatched: number;
  resultsReceived: number;
  proofsSubmitted: number;
  staleDrops: number;
  submissionErrors: number;
  // Per-backend dedup count. Aggregator passes this through from the
  // child's `controller.duplicate_result_drops` so the per-mode table
  // matches the headline tile.
  duplicateResultDrops: number;
  // Worker handles this child owns (`{id, type}`). Lets the UI
  // show "cpu mode: 4 workers, qpu mode: 1 dwave handle" without
  // re-deriving from `miners[]` parsing.
  miners: Array<{ id: string; type: MinerCategory }>;
}

/**
 * Per-submission summary record sourced from the miner's
 * `/api/v1/mining/attempts?solution_number=N` endpoint. The indexer fetches
 * one envelope per global `solution_number`, derives `attemptCount` and
 * `bestEnergyMilli` from the iterations array, and persists this row. The
 * full iteration trail is NOT persisted — the modal proxies fresh through
 * `GET /api/mining/attempts/:solutionNumber` when opened.
 *
 * Milli-unit fields (`*Milli`) preserve the chain's integer encoding for
 * lossless re-derivation; the UI divides by 1000 at display time.
 * `chainBlockNumber` / `chainBlockHash` / `extrinsicHash` are null until the
 * submission lands on-chain (outcome=`submitted_inblock` typically).
 */
export interface MiningSubmissionRecord {
  // Global chain solution number this submission was produced for
  // (`LatestQBlockId + 1`) at the time the miner opened the directory —
  // i.e. the network-wide problem index, durable and monotonic across
  // restarts. Every miner grinds the same global solution_number, so it's a
  // stable identity/sort key that no longer resets when the attempts dir is
  // moved.
  //
  // This is the key the modal proxies on
  // (`/api/v1/mining/attempts?solution_number=N`) and the DB primary
  // key. The "Sol #" column does NOT render this raw — it's chain-derived
  // from `chainBlockNumber ?? powSequence ?? solutionNumber`.
  solutionNumber: number;
  minerId: string;
  // Backend that produced this submission — CPU / CUDA / METAL / MODAL
  // / QPU. In multi-backend containers (one quip-miner process per
  // active config group) this is the only way to tell which backend
  // cleared the target for a given winning block. Empty string for
  // rows from miners that don't yet surface the field (older images
  // pre-dating the v17 telemetry plumbing).
  minerType: string;
  // Submission wall-clock from the miner. u128 nanoseconds as string —
  // exceeds Number.MAX_SAFE_INTEGER for any chain past ~292 years from
  // epoch, but we keep it precise regardless for future-proofing.
  tsNs: string;
  energyMilli: number;
  diversityMilli: number;
  // The decayed difficulty the miner targeted at submission time. Comparing
  // this against the chain's `current_difficulty()` surfaces miner-side
  // decay-tracking bugs directly.
  thresholdMilli: number;
  lastProofBlockHash: string;
  extrinsicHash: string | null;
  chainBlockHash: string | null;
  chainBlockNumber: string | null; // u64 as string
  // On-chain `proofs_submitted` sequence at submit time (quip-protocol
  // MR !105), attached to non-winning submissions (rejected_stale /
  // chain_error). Winners carry `chainBlockNumber` instead — the two
  // are mutually exclusive by outcome (the controller records one or
  // the other), and the "Sol #" column reads whichever is present.
  // Null for winners and for pre-!105 miners that publish neither.
  powSequence: number | null;
  // Open enum: 'submitted_inblock' | 'rejected' | 'stored' | … — preserved
  // verbatim from the miner so future outcomes show up in the UI unchanged.
  outcome: string;
  attemptCount: number;
  // Derived: min(attempts[].best_energy_milli). Lets the table show "best
  // energy this submission ever reached" without unpacking iterations.
  bestEnergyMilli: number;
  // Count behind the Recent Performance "Solutions" column.
  //
  // Authoritative source (quip-protocol MR !105): the submission-level
  // `num_valid` field, recorded on every submission — the target-AWARE
  // count of unique samples meeting the energy threshold at submit time
  // (the count the chain accepts: ≥ min_solutions below max_energy).
  // !105 added this stable, per-submission value precisely so this
  // column no longer has to dig into the iteration trail.
  //
  // Fallback for pre-!105 envelopes: derived from the submitted
  // iteration's `solution_meta.n_unique_total` (!103+, the target-BLIND
  // sampler-productivity count), or the legacy per-iteration `num_valid`
  // for pre-!103 images. So the column reads "valid solutions meeting
  // target" for current miners and "sampler productivity" for ancient
  // ones — it converges on the former as the fleet upgrades.
  //
  // Distinct from the chain-side BlockRecord.numValidSolutions
  // (validator's count for a winning proof) and from the per-iter
  // below-threshold count (solution_meta.n_unique_below_threshold,
  // surfaced in the in-flight attempts panel). 0 when the miner
  // surfaced no count anywhere.
  numValid: number;
  // Per-submission sum of D-Wave's `qpu_access_time` across every
  // iteration of this submission (microseconds). Captures the *real*
  // time the QPU spent annealing + reading out — distinct from
  // wall-clock `mining_time_us`, which is dominated by D-Wave cloud
  // network round-trip + queue and so wildly overstates QPU compute.
  //
  // The miner surfaces `qpu_access_time_us` on each iteration in its
  // attempts JSONL output since quip-protocol v0.2.0 (db4ed96,
  // 2026-05-26) — every v0.2.x release emits it. Rows only exist for
  // solutions the locally-polled miner actually *submitted* (the
  // attempts endpoint 404s without a submission.json), so a 0/empty
  // column means no recent self-submissions, not a missing field.
  //
  // Always 0 for CPU/GPU miners — they have no quantum sampler and
  // their wall-clock mining time is the right metric for the
  // "compute used" chart.
  qpuAccessTimeUs: number;
  observedAt: string; // ISO 8601 when the indexer fetched this submission
  // True for UI-synthesized rows derived from a chain block when the
  // local mining_submissions table has no matching row (typical after
  // a miner restart that wiped its attempts log). Synthetic rows carry
  // chain-authoritative energy/diversity/numValid but no
  // `attemptCount` or genuine `solutionNumber` — the panel renders
  // em-dashes for those columns and disables modal click-through.
  // Never set by the server / DB layer; populated only in
  // `use-my-node`.
  chainOnly?: boolean;
}

/**
 * Per-iteration row inside a mining submission. Returned by the server's
 * `/api/mining/attempts/:solutionNumber` proxy on modal open. Not
 * persisted — the iteration trail can grow unbounded per submission so we
 * re-fetch fresh from the miner each time.
 *
 * `extra` carries the additional fields the miner returns beyond the
 * known shape (`ts_ns`, `solution_meta`, iteration timing, etc.) so the
 * modal can display them without the indexer/server having to know about
 * every field the miner adds in the future.
 */
export interface MiningAttempt {
  iter: number;
  bestEnergyMilli: number;
  // Open enum: 'rejected' | 'stored' | 'submitted' | … — preserved verbatim
  // from the miner's `result_kind` field.
  resultKind: string;
  // Backend that produced this iteration — hoisted from the JSONL's
  // `miner_type` field so the modal can show per-iteration backend
  // attribution without unpacking `extra`. Empty string for miners
  // that don't surface the field yet.
  minerType: string;
  extra: Record<string, unknown>;
}

/**
 * Envelope returned by `/api/mining/attempts/:solutionNumber`. Mirrors the
 * miner's response shape but with camelCase keys; the server proxies and
 * re-shapes via `parseMiningAttemptsApiResponse` in `api/miner-api.ts`.
 */
export interface MiningAttemptsResponse {
  submission: MiningSubmissionRecord;
  attempts: MiningAttempt[];
}

export interface CurrentDispatch {
  // Global solution_number this iteration trail is grinding (MR !105):
  // `Σ proofsWon + 1` for the in-flight problem, or `Σ proofsWon` for the
  // just-completed one.
  solutionNumber: number;
  attempts: MiningAttempt[];
  status: "in-flight" | "completed";
}
