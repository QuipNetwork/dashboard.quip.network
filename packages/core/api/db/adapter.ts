// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  MineableTopologyRecord,
  MinerHardwareRecord,
  MinerStats,
  MinerWinsRow,
  MiningHistoryRow,
  MiningSubmissionRecord,
  ModeBreakdown,
  NodeDescriptorRecord,
} from "@quip/shared/telemetry";
import type { MigrationStatusRow } from "./migrator";

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
 */
export function parseIndexerObservability(raw: string): IndexerObservability | null {
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
    selfIdentified: typeof p.selfIdentified === "boolean" ? p.selfIdentified : undefined,
    nodeSyncing: typeof p.nodeSyncing === "boolean" ? p.nodeSyncing : undefined,
    nodeSyncCurrentBlock: isNullableStr(p.nodeSyncCurrentBlock)
      ? p.nodeSyncCurrentBlock
      : undefined,
    nodeSyncHighestBlock: isNullableStr(p.nodeSyncHighestBlock)
      ? p.nodeSyncHighestBlock
      : undefined,
    minerStats: parseMinerStats(p.minerStats),
    modes: parseModeBreakdownMap(p.modes),
    indexer: parseIndexerProgress(p.indexer),
  };
}

/**
 * Best-effort parse of the optional pipeline backfill-progress sub-object
 * (spec §11). Tolerant of absence (pre-redesign rows) and of malformed
 * payloads — both degrade to undefined, mirroring the `modes?` handling.
 */
function parseIndexerProgress(raw: unknown): IndexerObservability["indexer"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.backfillQueueDepth !== "number") return undefined;
  if (!p.coverage || typeof p.coverage !== "object") return undefined;
  const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === "string";
  if (!isNullableStr(p.difficultyDataStartBlock ?? null)) return undefined;

  const coverage: NonNullable<IndexerObservability["indexer"]>["coverage"] = {};
  for (const [name, entry] of Object.entries(p.coverage as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return undefined;
    const e = entry as Record<string, unknown>;
    if (
      !isNullableStr(e.low) ||
      !isNullableStr(e.high) ||
      typeof e.gapBlocks !== "number" ||
      !isNullableStr(e.prunedFloor) ||
      !isNullableStr(e.topologyEnrichmentFloor) ||
      typeof e.generation !== "number"
    ) {
      return undefined;
    }
    coverage[name] = {
      low: e.low,
      high: e.high,
      gapBlocks: e.gapBlocks,
      prunedFloor: e.prunedFloor,
      topologyEnrichmentFloor: e.topologyEnrichmentFloor,
      generation: e.generation,
    };
  }
  return {
    backfillQueueDepth: p.backfillQueueDepth,
    coverage,
    difficultyDataStartBlock: (p.difficultyDataStartBlock ?? null) as string | null,
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
  /** Apply all pending forward migrations to latest. */
  migrate(): Promise<void>;
  /** Every known migration and whether it has been applied. */
  migrationStatus(): Promise<MigrationStatusRow[]>;
  /** Names of migrations that a migrate() would apply, in order (dry run). */
  pendingMigrations(): Promise<string[]>;

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
   * All-time per-miner win aggregates (`GROUP BY miner_id` over `blocks`),
   * wins descending. The single dataset behind every "qblocks won" surface —
   * see `MinerWinsRow` for the coverage caveat vs the on-chain counter.
   */
  getMinerWins(): Promise<MinerWinsRow[]>;

  /**
   * Slim winner-block rows whose `timestamp` is at/after the ISO cutoff,
   * ascending by block number — the range-windowed dataset behind the
   * mining-time chart (`GET /api/mining-history`).
   */
  getMiningHistorySince(sinceIso: string): Promise<MiningHistoryRow[]>;

  /**
   * Topology-tag backfill support. Returns up to `limit` blocks whose
   * `topology_hash` is NULL (rows that predate per-block topology tagging),
   * newest first, so the indexer can re-read each block's qblock and stamp its
   * true topology. `{ blockHash, substrateBlockNumber }` is all the backfill
   * needs (PK + the chain block number to look up the qblock).
   */
  getBlocksMissingTopology(
    limit: number,
  ): Promise<Array<{ blockHash: string; substrateBlockNumber: string }>>;

  /** Set one block's `topology_hash` (backfill writes, keyed on the PK). */
  setBlockTopology(blockHash: string, topologyHash: string): Promise<void>;

  /**
   * Backfill `topology_hash` on still-untagged `difficulty_history` rows at or
   * after `fromBlock` (the first block of the current default topology's run),
   * stamping them with the current default `topologyHash`. Returns the row
   * count updated. Rows before `fromBlock` belong to a prior topology and stay
   * NULL (out of scope).
   */
  backfillDifficultyTopology(fromBlock: string, topologyHash: string): Promise<number>;

  /**
   * Of the supplied substrate block numbers, return those already present in
   * `blocks`. Used by the startup/reconnect backfill to compute exactly which
   * on-chain winners are missing locally — a targeted membership test that
   * stays correct (and cheap) no matter how large the chain or the winner set
   * grows. Empty input is a no-op.
   */
  getExistingBlockNumbers(blockNumbers: string[]): Promise<string[]>;

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
  // Difficulty snapshots at/after an ISO cutoff, ordered oldest-first for
  // direct left-to-right charting. Feeds the range-windowed difficulty panel.
  getDifficultySince(sinceIso: string): Promise<DifficultyRecord[]>;
  /**
   * The newest snapshot strictly before `sinceIso` — the window anchor: a
   * range shorter than the current stable-difficulty stretch still renders
   * the prevailing step instead of an empty chart (spec §10.5). Strictly
   * before, because a row exactly at the cutoff is already in the
   * `getDifficultySince` window.
   */
  getDifficultyAnchorBefore(sinceIso: string): Promise<DifficultyRecord | null>;
  /**
   * Delete one writer's rows (R4 `--reindex difficulty` drops only 'block'
   * rows; 'poll' snapshots are not re-derivable and are never dropped by
   * reindex). Returns the deleted row count.
   */
  deleteDifficultyHistoryBySource(source: "block" | "poll"): Promise<number>;

  // --- Pipeline coverage cursors (spec §7) ---
  // Per-indexable coverage JSON + generation counter in the meta KV. The
  // generation-guarded flush is what makes `--reindex` safe against a stale
  // in-flight coverage write from pre-drop work.
  getCoverage(name: string): Promise<string | null>;
  clearCoverage(name: string): Promise<void>;
  getIndexerGeneration(name: string): Promise<number>;
  /** Increment the generation (reindex step 1); returns the new value. */
  bumpIndexerGeneration(name: string): Promise<number>;
  /** Write coverage only when the stamped generation is still current. */
  setCoverageIfGeneration(name: string, gen: number, json: string): Promise<boolean>;

  // Current per-topology difficulty snapshot for the chain's mineable
  // whitelist (`quantum_pow` runtime APIs). Current-state, not history:
  // `setMineableTopologies` replaces the whole set each poll, stored as a
  // single `meta` JSON row. Empty when the substrate worker hasn't observed
  // any topology (or the runtime APIs are absent pre-v0.2).
  setMineableTopologies(records: MineableTopologyRecord[]): Promise<void>;
  getMineableTopologies(): Promise<MineableTopologyRecord[]>;

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
   * Record that `accountId` authored `blockNumber` (`hasPow=true` when the
   * head also carried a `quantumPow.BlockWinner` event). Row-per-(validator,
   * block) insert, idempotent at the row level — crash replays, reconnect
   * replays, and reconciler re-visits are no-ops (spec §9.1).
   */
  recordValidatorAuthorship(
    accountId: string,
    blockNumber: string,
    blockTimestamp: number,
    hasPow: boolean,
  ): Promise<void>;

  /**
   * Bulk read for the server's `/api/telemetry` join against the active
   * BABE authority set. Sorted DESC by `blocksAuthored`; `lastAuthoredAt`
   * is ISO 8601. Before the authorship cutover this serves the per-validator
   * union of the frozen legacy counters and the live row-per-block aggregate
   * (never stale, never regressing); after cutover it reads the summary
   * cache kept fresh by `recomputeAuthorshipSummary` (spec §9.2).
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

  /**
   * Flip reads to the summary cache once every legacy validator's new-table
   * count has caught up (`newCount >= oldCount` per validator — values only
   * jump up at the flip). Recomputes the summary and sets the cutover flag
   * in one transaction. Returns whether the cutover is in effect; safe to
   * call repeatedly. The reconciler calls this only when the authorship
   * coverage conditions hold (gaps = ∅, low/high reached; spec §9.2).
   */
  tryAuthorshipCutover(): Promise<boolean>;

  /**
   * Idempotent full recompute (never increment) of the `validator_authorship`
   * summary cache from `validator_authorship_blocks`. Called on coverage
   * flushes after cutover (spec §9.2).
   */
  recomputeAuthorshipSummary(): Promise<void>;

  /**
   * R4 `--reindex authorship`: delete the row-per-block facts and clear the
   * cutover flag so reads fall back to the union (the summary table keeps
   * its last values as the union's frozen side — values never regress
   * during the re-walk; spec §8). Coverage/generation are the runner's job.
   */
  resetAuthorshipHistory(): Promise<void>;

  /** Whether the authorship cutover flag is set (cheap meta read). */
  isAuthorshipCutover(): Promise<boolean>;

  /**
   * Which of `blockNumbers` already carry a winner-derived ('block') row —
   * the difficulty drift cross-check's existence probe (spec §5). Indexed
   * `IN` on the primary key; the `source` filter applies after the lookup.
   */
  getExistingDifficultyBlockNumbers(blockNumbers: string[]): Promise<string[]>;

  /**
   * Authorship rows inside `[fromBlock, toBlock]` — the reconciler's
   * per-chunk sample check (spec §5), served by the block_number index.
   */
  countAuthorshipBlocksInRange(fromBlock: string, toBlock: string): Promise<number>;

  /** R4 `--reindex winners`: delete all `blocks` rows. Returns the count. */
  deleteAllBlocks(): Promise<number>;

  // --- Node descriptors (v11) ---
  // Per-account chain-signed identity records — one row per AccountId,
  // sourced from `MinerRegistry.NodeDescriptors` compact storage carrying
  // runtime-validated `quip.node_descriptor.v1` data. Replaces the v0.2
  // miner-survey pipeline as the canonical node-identity surface.
  //
  // Upsert tie-breaker remains `(blockNumber, extrinsicIndex)` for DB
  // compatibility. Registry snapshots use `extrinsicIndex = 0`, and the
  // `blockNumber` is the descriptor's own `updated_at` provenance.
  // `firstBlockTimestamp` is preserved across upserts so the dashboard can
  // report "first observed" without keeping a history table.

  /**
   * Insert-or-replace a descriptor by accountId. Skips the write when the
   * stored row's `(block_number, extrinsic_index)` already orders strictly
   * later than the incoming one — protects against out-of-order live + backfill.
   */
  upsertNodeDescriptor(record: NodeDescriptorRecord): Promise<void>;

  /**
   * All descriptors known to the indexer, ordered by `nodeName` for stable
   * UI rendering. Empty when no `quip-miner identify` registry update has
   * been observed yet. Re-projected to NodesSnapshot at server time.
   */
  getAllNodeDescriptors(): Promise<NodeDescriptorRecord[]>;

  /**
   * Single-row lookup by SS58 account. Returned by the URL-resolver helper
   * when deriving the local operator's miner-REST base URL from their
   * on-chain descriptor (`publicHost`/`publicPort`). Null when the operator
   * hasn't yet written a `quip.node_descriptor.v1` registry entry for this account.
   */
  getNodeDescriptor(accountId: string): Promise<NodeDescriptorRecord | null>;

  /**
   * Lower an account's `first_block_timestamp` ("firstSeen") to the supplied
   * value if it is earlier, leaving it untouched otherwise. Used by the
   * offline firstSeen reconstruction to correct rows seeded from a head
   * snapshot (which only knows the latest `updated_at`) down to the true
   * first-registration timestamp. Never raises firstSeen, and is a no-op when
   * no row exists for the account.
   */
  backfillNodeDescriptorFirstSeen(accountId: string, firstBlockTimestamp: number): Promise<void>;

  /**
   * Read the highest substrate block height the descriptor worker has
   * scanned (inclusive). Null until the first scan completes.
   */
  getDescriptorCheckpoint(): Promise<string | null>;

  /** Persist the descriptor-worker's last-scanned block. Monotonic-only. */
  setDescriptorCheckpoint(blockNumber: string): Promise<void>;

  // --- Mining submissions (v13) ---
  // Per-submission summaries sourced from the locally-polled miner's
  // `/api/v1/mining/attempts?solution_number=N` endpoint. One row per
  // global `solution_number` (the chain winning-solution index the miner
  // worked, MR !105), keyed by `(minerId, solutionNumber)` so multiple
  // miners polled by the same dashboard never collide. Iteration-level
  // rows are NOT stored — the server proxies them fresh on modal open.

  /**
   * Idempotent insert-or-update by `(minerId, solutionNumber)`. The
   * indexer may re-fetch a submission whose `chainBlockNumber` was null on
   * first observation (extrinsic submitted but not yet on-chain); the
   * second fetch flips that field and we want the row to update without
   * losing the original `observedAt`.
   */
  insertMiningSubmission(record: MiningSubmissionRecord): Promise<void>;

  /**
   * Recent submissions by `minerId`, newest first by `solutionNumber`. The
   * server caller passes `selfAddress` so only the locally-polled miner's
   * submissions surface in the UI panel.
   */
  getRecentMiningSubmissions(minerId: string, limit: number): Promise<MiningSubmissionRecord[]>;

  /**
   * Lifetime count of distinct `solutionNumber`s persisted for this miner
   * where the iteration list was non-empty — the operator-facing "Problems
   * Attempted" tile. Differs from `controller.contexts_dispatched` (which
   * counts dispatches, possibly with refreshes per problem); this counts
   * solutions for which at least one iteration row was recorded.
   */
  countMiningSubmissionsWithAttempts(minerId: string): Promise<number>;

  /**
   * Highest global `solutionNumber` the indexer has fetched + persisted
   * for this miner. Returned as a number (solution_number is u64 but fits
   * comfortably in Number until ~9 quadrillion solutions). Null until the
   * first submission lands.
   */
  getMiningCheckpoint(minerId: string): Promise<number | null>;

  /**
   * Monotonic advance — never rewinds. Guards against a misconfigured
   * restart that resumes from an earlier checkpoint than what we already
   * persisted. The catch-up loop also uses it to seed the cursor near the
   * current global solution_number on first contact (so it never grinds
   * ancient solution_numbers this miner predates).
   */
  setMiningCheckpoint(minerId: string, solutionNumber: number): Promise<void>;

  /**
   * Drop every persisted submission for this miner and clear its
   * checkpoint. A maintenance primitive (e.g. an operator nuked the
   * miner's `/data` so its on-disk solution directories no longer back
   * the persisted rows). Not triggered automatically: with MR !105 the
   * global `solution_number` is durable and only advances, so there is no
   * counter-regression signal to wipe on.
   */
  resetMiningHistory(minerId: string): Promise<void>;
}

export interface DbConfig {
  databaseUrl: string;
  /**
   * Max connections in the postgres pool. Defaults to a modest pool when
   * unset. Raise it for a server fronting many concurrent clients; keep it
   * low on serverless, where each instance opens its own pool against a
   * shared connection budget.
   */
  poolMax?: number;
}
