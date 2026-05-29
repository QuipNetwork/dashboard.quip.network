// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  MinerHardwareRecord,
  MinerStats,
  MiningSubmissionRecord,
  ModeBreakdown,
  NodeDescriptorRecord,
} from "../../src/types/telemetry";

/**
 * Runtime-validate a raw `indexer_observability` meta payload before casting.
 * The stored value is opaque TEXT in both adapters; shape drift (field rename,
 * nullability change, manual DB edit) would otherwise sail past TS's compile-
 * time types and produce NaN arithmetic downstream in `computeChainHealth`.
 *
 * Returns null on any parse or top-level shape failure — the indexer
 * overwrites on the next poll, so a transient bad row shouldn't break the
 * telemetry endpoint. `minerStats` is best-effort: a malformed sub-object
 * degrades to `null` rather than rejecting the whole record.
 *
 * The `_adapter` parameter is unused in v6 (no adapter-specific logic) but
 * kept for API compatibility with sqlite/postgres callers.
 */
export function parseIndexerObservability(
  raw: string,
  _adapter: "sqlite" | "postgres",
): IndexerObservability | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === "string";

  if (!isStr(p.lastStatusFetchAt)) return null;
  if (!isNullableStr(p.lastBlockInsertAt)) return null;
  if (!isNullableStr(p.lastSubstrateEventAt)) return null;
  if (!isNullableStr(p.bestBlockHeight)) return null;
  if (!isNullableStr(p.finalizedBlockHeight)) return null;
  if (typeof p.chainConnected !== "boolean") return null;
  if (!isNullableStr(p.chainHeadFromNode)) return null;

  return {
    chainHeadFromNode: p.chainHeadFromNode,
    lastStatusFetchAt: p.lastStatusFetchAt,
    lastBlockInsertAt: p.lastBlockInsertAt,
    lastSubstrateEventAt: p.lastSubstrateEventAt,
    bestBlockHeight: p.bestBlockHeight,
    finalizedBlockHeight: p.finalizedBlockHeight,
    chainConnected: p.chainConnected,
    minerStats: parseMinerStats(p.minerStats),
    modes: parseModeBreakdownMap(p.modes),
  };
}

/**
 * Best-effort parse of the optional `minerStats` sub-object. Returns null if
 * the payload is missing, not an object, or lacks the required pipeline
 * counter `contextsDispatched`. Other numeric fields default to 0 when
 * absent/non-finite so the UI never has to guard NaN.
 */
function parseMinerStats(raw: unknown): MinerStats | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cd = n(r.contextsDispatched);
  if (cd === null) return null;
  return {
    headsObserved: n(r.headsObserved) ?? 0,
    contextsDispatched: cd,
    resultsReceived: n(r.resultsReceived) ?? 0,
    proofsSubmitted: n(r.proofsSubmitted) ?? 0,
    staleDrops: n(r.staleDrops) ?? 0,
    submissionErrors: n(r.submissionErrors) ?? 0,
    duplicateResultDrops: n(r.duplicateResultDrops) ?? 0,
  };
}

/**
 * Best-effort parse of the per-backend breakdown the aggregator
 * surfaces on `/api/v1/status.modes`. Defaults to `{}` for legacy
 * observability rows persisted before v17 — the UI degrades to the
 * single-process display when modes is empty.
 */
function parseModeBreakdownMap(raw: unknown): Record<string, ModeBreakdown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModeBreakdown> = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    const minersRaw = Array.isArray(v.miners) ? (v.miners as Array<Record<string, unknown>>) : [];
    out[mode] = {
      headsObserved: n(v.headsObserved),
      contextsDispatched: n(v.contextsDispatched),
      resultsReceived: n(v.resultsReceived),
      proofsSubmitted: n(v.proofsSubmitted),
      staleDrops: n(v.staleDrops),
      submissionErrors: n(v.submissionErrors),
      duplicateResultDrops: n(v.duplicateResultDrops),
      miners: minersRaw.map((m) => {
        const t = String(m.type ?? "").toUpperCase();
        const type = t === "CPU" || t === "GPU" || t === "QPU" ? t : ("OTHER" as const);
        return { id: String(m.id ?? ""), type };
      }),
    };
  }
  return out;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;

  // --- Blocks (substrate-canonical; no epoch coupling) ---
  // The substrate worker is the sole writer. Every column is populated at
  // insert time — no two-phase enrichment, no stale-fork canonicalisation.

  /**
   * Insert one block row. Substrate worker calls this when a new head
   * arrives. `block_hash` is the primary key; a duplicate insert (same
   * worker seeing the same head twice) must be an idempotent no-op.
   */
  insertBlock(block: BlockRecord): Promise<void>;

  /**
   * Default chart read: newest first, paginated. `offset` defaults to 0.
   * Used by `RecentBlocksTable` and the time-series visualisations.
   */
  getRecentBlocks(limit: number, offset?: number): Promise<BlockRecord[]>;

  /**
   * MyNodeView's last-N-wins query. Filters by `miner_id` (SS58) and
   * returns newest first. The dashboard joins with miner_hardware at read
   * time on the server.
   */
  getBlocksByMiner(minerId: string, limit: number): Promise<BlockRecord[]>;

  /**
   * Substrate worker flips `finalized=true` when finality lags catches a
   * block. Idempotent — re-running on an already-finalised hash is a no-op.
   * Silently no-ops if the hash is unknown (the worker may see finality
   * for a block we haven't inserted yet under reorg-edge timing).
   */
  markBlockFinalized(blockHash: string): Promise<void>;

  // --- Self-identity ---
  // SS58 of the local operator (the validator whose session keys this
  // RPC node holds). Persisted in `meta` so the server can tell the UI
  // which chain_miners entry is "us" without having to re-probe the
  // substrate client each request. Null until the indexer has resolved
  // self-identity via `discoverLocalValidator` and successfully polled
  // the miner's `/api/v1/status`.
  getSelfAddress(): Promise<string | null>;
  setSelfAddress(address: string | null): Promise<void>;

  // --- Indexer observability ---
  // The indexer writes this on every successful /api/v1/status poll; the
  // server reads it on /api/telemetry so the UI can distinguish "no new
  // blocks" from "indexer falling behind". Null until first successful
  // poll. v6 adds `minerStats`; see telemetry.IndexerObservability.
  getIndexerObservability(): Promise<IndexerObservability | null>;
  setIndexerObservability(obs: IndexerObservability): Promise<void>;

  // --- Substrate-derived state (unchanged from v5) ---
  // All methods are filled by the substrate worker when at least one
  // URL in QUIP_VALIDATOR_RPC_URLS accepts a connection; otherwise the
  // tables stay empty and reads return null/[]. Each upsert is
  // idempotent — a no-change call must be a no-op
  // at the row level (use ON CONFLICT DO UPDATE … WHERE … IS DISTINCT FROM).

  upsertChainHead(head: ChainHead): Promise<void>;
  getChainHead(): Promise<ChainHead | null>;

  upsertBabeEpoch(epoch: BabeEpochState): Promise<void>;
  getCurrentBabeEpoch(): Promise<BabeEpochState | null>;

  // Replace-in-place the BABE authorities for the given epoch. UPSERT
  // by accountId, flip is_active=false for prior accounts not in the new
  // set. Never deletes — preserves per-epoch history.
  upsertBabeAuthorities(epochIndex: number, authorities: BabeAuthorityRecord[]): Promise<void>;
  getActiveBabeAuthorities(): Promise<BabeAuthorityRecord[]>;

  // On-chain miner state from quantum_pow.Miners. The hardware/category
  // join happens at read time in the server, not write time — keep this
  // table chain-pure.
  upsertChainMiners(
    miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">>,
  ): Promise<void>;
  getChainMiners(): Promise<Array<Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">>>;

  // Append-only difficulty snapshots. Worker dedupes against most recent
  // before calling; ON CONFLICT DO NOTHING covers the race where two
  // workers see the same boundary block.
  insertDifficultySnapshot(snapshot: DifficultyRecord): Promise<void>;
  getRecentDifficulty(limit: number): Promise<DifficultyRecord[]>;

  // --- Miner hardware identity ---
  // Per-miner hardware inventory keyed by SS58 account. v0.3 only ever
  // writes one row (source='self') from the locally polled quip-node;
  // peer-query and chain surfaces are reserved for later versions.

  /**
   * Idempotent insert-or-replace by `account_id`. Re-running with the same
   * payload must be a no-op at the row level (no spurious update timestamp
   * churn). Tip-worker is the sole writer.
   */
  upsertMinerHardware(record: MinerHardwareRecord): Promise<void>;

  /** Single-row lookup by SS58 account. Null when nothing has been written. */
  getMinerHardware(accountId: string): Promise<MinerHardwareRecord | null>;

  /**
   * Bulk read for the server's `/api/telemetry` join. Order is unspecified
   * — callers re-sort against `chain_miners` for the UI.
   */
  getAllMinerHardware(): Promise<MinerHardwareRecord[]>;

  // --- Validator authorship (v7) ---
  // Per-validator aggregate counters. The substrate worker calls
  // recordValidatorAuthorship() once per finalized head it can attribute to
  // an author (via api.derive.chain.* author extraction). `hasPow=true`
  // when the head also carried a `quantumPow.BlockWinner` event, so the
  // dashboard can split "validator that authored" vs "validator that also
  // won a PoW reward" without a separate join.

  /**
   * Increment authorship counters for `accountId` by 1; also increment the
   * PoW counter by 1 when `hasPow=true`. Updates `last_authored_block` and
   * `last_authored_at` to reflect the most recent observed head. Idempotency
   * is at the caller — the worker should only fire this once per finalized
   * head it sees.
   */
  recordValidatorAuthorship(
    accountId: string,
    blockNumber: string,
    blockTimestamp: number,
    hasPow: boolean,
  ): Promise<void>;

  /**
   * Bulk read for the server's `/api/telemetry` join against the active
   * BABE authority set. Sorted DESC by `blocksAuthored` so the most active
   * authors are surfaced first. `lastAuthoredAt` is ISO 8601.
   */
  getValidatorAuthorship(): Promise<
    Array<{
      accountId: string;
      blocksAuthored: number;
      blocksAuthoredWithPow: number;
      lastAuthoredBlock: string;
      lastAuthoredAt: string;
    }>
  >;

  // --- Node descriptors (v11) ---
  // Per-account chain-signed identity records — one row per AccountId,
  // sourced from `System.remark_with_event` extrinsics carrying a
  // `quip.node_descriptor.v1` JSON body. Replaces the v0.2 miner-survey
  // pipeline as the canonical node-identity surface; see DASHBOARDPLAN.md.
  //
  // Upsert tie-breaker is `(blockNumber, extrinsicIndex)` so a later
  // descriptor in the same block wins, and across blocks the newest one
  // always wins. `firstBlockTimestamp` is preserved across upserts so the
  // dashboard can report "first observed" without keeping a history table.

  /**
   * Insert-or-replace a descriptor by accountId. Skips the write when the
   * stored row's `(block_number, extrinsic_index)` already orders strictly
   * later than the incoming one — protects against out-of-order live + backfill.
   */
  upsertNodeDescriptor(record: NodeDescriptorRecord): Promise<void>;

  /**
   * All descriptors known to the indexer, ordered by `nodeName` for stable
   * UI rendering. Empty when no `quip-miner identify` extrinsic has been
   * observed yet. Re-projected to NodesSnapshot at server time.
   */
  getAllNodeDescriptors(): Promise<NodeDescriptorRecord[]>;

  /**
   * Single-row lookup by SS58 account. Returned by the URL-resolver helper
   * when deriving the local operator's miner-REST base URL from their
   * on-chain descriptor (`publicHost`/`publicPort`). Null when the operator
   * hasn't yet signed a `quip.node_descriptor.v1` remark for this account.
   */
  getNodeDescriptor(accountId: string): Promise<NodeDescriptorRecord | null>;

  /**
   * Read the highest substrate block height the descriptor worker has
   * scanned (inclusive). Null until the first scan completes.
   */
  getDescriptorCheckpoint(): Promise<string | null>;

  /** Persist the descriptor-worker's last-scanned block. Monotonic-only. */
  setDescriptorCheckpoint(blockNumber: string): Promise<void>;

  // --- Mining submissions (v13) ---
  // Per-submission summaries sourced from the locally-polled miner's
  // `/api/v1/mining/attempts?solution_id=N` endpoint. One row per
  // `solution_id` (the controller-assigned monotonic submission counter),
  // keyed by `(minerId, solutionId)` so multiple miners polled by the same
  // dashboard never collide. Iteration-level rows are NOT stored — the
  // server proxies them fresh on modal open.

  /**
   * Idempotent insert-or-update by `(minerId, solutionId)`. The indexer
   * may re-fetch a submission whose `chainBlockNumber` was null on first
   * observation (extrinsic submitted but not yet on-chain); the second
   * fetch flips that field and we want the row to update without losing
   * the original `observedAt`.
   */
  insertMiningSubmission(record: MiningSubmissionRecord): Promise<void>;

  /**
   * Recent submissions by `minerId`, newest first by `solutionId`. The
   * server caller passes `selfAddress` so only the locally-polled miner's
   * submissions surface in the UI panel.
   */
  getRecentMiningSubmissions(minerId: string, limit: number): Promise<MiningSubmissionRecord[]>;

  /**
   * Lifetime count of distinct `solutionId`s persisted for this miner where
   * the iteration list was non-empty — the operator-facing "Problems
   * Attempted" tile. Differs from `controller.contexts_dispatched` (which
   * counts dispatches, possibly with refreshes per problem); this counts
   * solutions for which at least one iteration row was recorded.
   */
  countMiningSubmissionsWithAttempts(minerId: string): Promise<number>;

  /**
   * Highest `solutionId` the indexer has fetched + persisted for this
   * miner. Returned as a number (solution_id is u64 but fits comfortably
   * in Number until ~9 quadrillion submissions). Null until the first
   * submission lands.
   */
  getMiningCheckpoint(minerId: string): Promise<number | null>;

  /**
   * Monotonic advance — never rewinds. Guards against a misconfigured
   * restart that resumes from an earlier checkpoint than what we already
   * persisted.
   */
  setMiningCheckpoint(minerId: string, solutionId: number): Promise<void>;

  /**
   * Drop every persisted submission for this miner and clear its
   * checkpoint. Called when the indexer detects that the miner has
   * been reset (controller's `results_received` regressed below the
   * checkpoint) so the next catch-up loop refetches from solution_id=1
   * against the fresh miner instead of leaving stale rows visible.
   */
  resetMiningHistory(minerId: string): Promise<void>;
}

export interface DbConfig {
  adapter: "sqlite" | "postgres";
  databaseUrl?: string;
  sqlitePath?: string;
}

// Bump whenever any SCHEMA_STATEMENTS block in sqlite.ts / postgres.ts
// changes shape (add/drop column, add/drop table, add/drop index). On any
// version mismatch the adapter drops all OWNED_TABLES and recreates the
// schema; the indexer rebuilds derived state from the chain + miner REST
// on its next poll, so wipe-on-drift is the upgrade path for all
// environments including production Postgres.
//
// v2: force local re-index after switching the indexer to chain-aware
// attribution. Pre-v2 data tagged the same block under every epoch that
// inherited it, so "Apr 22 @ 4:00pm" blocks could have Apr 17 timestamps.
// The table shape didn't change but the semantics of `blocks.epoch` did.
// v3: second re-index — v2 indexed only the canonical chain and dropped
// dead-chain history on the floor. v3 indexes dead chains alongside the
// canonical one with per-chain owned ranges. Same table shape.
// v4: node telemetry now identifies epochs by 16-char hex hash rather than
// unix timestamp. `blocks.epoch` and `indexer_state.cursor_epoch` flip from
// INTEGER/BIGINT to TEXT; new `epoch_status` table holds the node's
// live/stale_fork tag per epoch so the UI can badge the selector.
// v5: substrate-derived fields (v0.2.0 release; targets quip-protocol-rs
// spec_version 101). Adds substrate-side columns to `blocks`
// (substrate_block_number, substrate_block_hash, substrate_parent_hash,
// extrinsics_root, state_root, finalized, is_canonical). Adds new tables
// `chain_head`, `babe_epochs`, `babe_authorities`, `chain_miners`,
// `difficulty_history`. Adds `chain_anchor` column to `epoch_status`.
// Drops vestigial `indexer_state` table. All environments wipe and rebuild
// on version drift — the indexer repopulates from the chain on next poll.
// v6: chain becomes canonical block source (v0.3.0 breaking release; targets
// quip-protocol-rs spec_version >=101). Drops `epoch_status` (no PoW epoch
// concept) and `nodes_snapshot` (no peer list — chain_miners replaces it).
// Drops `epoch`, `block_index`, `is_canonical`, `miner_category`,
// `ecdsa_public_key` columns from `blocks`; promotes `block_hash` to PK;
// makes substrate_* columns NOT NULL; adds `quality_milli`, `reward` columns.
// Adds `miner_hardware` table for hardware/category data with a `source` enum
// (`self|peer-query|chain`) ready for future peer-query and chain-surface
// upgrades. All environments wipe and rebuild on version drift.
// v7: per-validator authorship counters. Adds `validator_authorship` table
// keyed by SS58 account; the substrate worker UPSERTs an increment on every
// finalized head whose author it can determine, with a separate counter for
// heads that also carried a `quantumPow.BlockWinner` event. The server joins
// this against the active BABE authority set for the new Active Validators
// view. Same drop-on-drift policy as prior bumps.
// v8: no new tables — the bump triggers wipe-on-drift so existing `blocks`
// rows (which carried approximate per-block difficulty values from a
// separate poll cadence) get refreshed with the per-block snapshot from
// quip-protocol-rs v0.2's `WinningSolutions[block_number].difficulty`
// storage map, surfaced via `QuantumPowApi::winning_solution()`.
// v9: drops `quality_milli` column from `blocks` and `min_quality` column
// from `difficulty_history`. v0.2 chain removed quality from both the
// `ProofAccepted` event (no longer 5th field) and `DifficultyConfig` (only
// `min_solutions`, `max_energy_milli`, `min_diversity_milli` remain), so
// these columns had nowhere to source values from. Wipe-on-drift rebuilds
// cleanly from the v0.2 event stream.
// v10: re-introduces `nodes_snapshot(id=1, payload TEXT)` for the new
// miner survey ingest path. Backs the restored PFLOPS/TFLOPS visuals
// without re-introducing the deleted PoW-epoch abstraction. Stored as a
// JSON blob keyed by a single row, overwritten on every survey poll.
// v11: drops `nodes_snapshot` and the HTTP fan-out survey-worker. Adds
// `node_descriptors` — one row per AccountId, populated from
// `System.remark_with_event` extrinsics carrying a `quip.node_descriptor.v1`
// JSON body. Server projects to NodesSnapshot at read time. This is the
// canonical chain-signed identity surface; see DASHBOARDPLAN.md.
// v12: adds `proof_attempts` — every chain-accepted ProofAccepted event,
// not only the lowest-energy winner per block. Lets the dashboard show
// "Recent Performance vs problem #N" — the in-flight attempts against
// the current mining target — instead of only past wins. Wipe-on-drift
// because pre-v12 indexers discarded non-winning ProofAccepted events at
// the substrate-worker boundary; backfill via the historical-win path
// is winners-only, so a fresh scan from genesis is the only way to
// repopulate.
// v13: drops `proof_attempts` (the chain-side "submissions vs current
// problem" surface) and replaces it with `mining_submissions` — per-
// submission summaries sourced from the locally-polled miner's
// `/api/v1/mining/attempts?solution_id=N` endpoint. The miner-side data
// is richer (sees attempts the miner self-rejected before submission,
// not just chain-accepted ones) and surfaces miner-side decay-tracking
// bugs directly via `thresholdMilli`. Iteration trails are NOT stored;
// the server proxies them on-demand for the modal. Wipe-on-drift because
// pre-v13 indexers had no concept of solution_id checkpoint.
// v14: adds `num_valid_solutions` column to mining_submissions, derived
// from the submitted iteration's `num_valid` field. Surfaces in the
// Recent Performance panel as the "Solutions" column — parallels the
// chain-side `BlockRecord.numValidSolutions`. Wipe-on-drift; on next
// poll the indexer re-fetches every submission with the new field.
// v15: renames mining_submissions.num_valid_solutions →
// num_solutions_meeting_target and re-sources from the submitted
// iteration's `num_solutions_meeting_target` field (the miner now
// publishes a count of batch members strictly below the live chain
// threshold). num_valid was the full SA batch size, not a count of
// chain-eligible solutions — the rename makes the semantic explicit.
// Wipe-on-drift so old rows (storing batch-size values) get rebuilt
// against the new field on next poll.
// v16: reverts the Recent Performance "Solutions" column back to the
// submitted iteration's `num_valid` (full unique constraint-valid
// count). The miner now decouples num_valid and
// num_solutions_meeting_target — num_valid is the dedup count over
// the full batch (target-blind) while num_solutions_meeting_target is
// the recomputed below-target subset. Operators reading the won-blocks
// table want sampler productivity (num_valid), not the trivial "5
// solutions submitted" view of meeting-target. The in-flight attempts
// panel keeps surfacing num_solutions_meeting_target — different
// audience, different question. Wipe-on-drift rebuilds against the
// new field on next poll.
// v18: adds `qpu_access_time_us` column to mining_submissions. Sum
// of D-Wave's `qpu_access_time` (microseconds) across every
// iteration of a submission. Replaces wall-clock as the source for
// the "Total Compute Used" QPU bar — wall-clock is dominated by
// D-Wave cloud RTT and overstates QPU compute by 100x+. 0 for
// CPU/GPU and for QPU rows produced before the miner started
// surfacing the field. Wipe-on-drift so the column populates on
// next poll.
// v19: re-sources the Recent Performance "Solutions" column
// (mining_submissions.num_valid) from the submitted iteration's
// `solution_meta.n_unique_total` (quip-protocol MR !103), falling back
// to the legacy top-level `num_valid` for pre-!103 miners. !103 dropped
// the per-iter `num_solutions_meeting_target` field and re-pointed
// `num_valid` to the target-aware below-threshold count, so an old
// indexer would have stored the trivial "~min_solutions" figure in the
// productivity column. The in-flight + modal attempts panels now read
// the below-target count from `solution_meta.n_unique_below_threshold`.
// Wipe-on-drift rebuilds the column from n_unique_total on next poll.
export const SCHEMA_VERSION = 19;

// Tables owned by this app. Listed explicitly so a drop-and-recreate can
// target exactly our data and never touch unrelated tables that may share
// a Postgres database.
export const OWNED_TABLES = [
  "blocks",
  "meta",
  "chain_head",
  "babe_epochs",
  "babe_authorities",
  "chain_miners",
  "difficulty_history",
  "miner_hardware",
  "validator_authorship",
  "node_descriptors",
  "mining_submissions",
] as const;
