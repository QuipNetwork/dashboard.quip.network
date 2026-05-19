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
  const isNullableStr = (v: unknown): v is string | null =>
    v === null || typeof v === "string";

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
  };
}

/**
 * Best-effort parse of the optional `minerStats` sub-object. Returns null if
 * the payload is missing, not an object, or lacks the two required counters
 * (`totalBlocksAttempted`, `totalBlocksWon`). Other numeric fields default to
 * 0 when absent/non-finite so the UI never has to guard NaN.
 */
function parseMinerStats(raw: unknown): MinerStats | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const a = n(r.totalBlocksAttempted);
  const w = n(r.totalBlocksWon);
  if (a === null || w === null) return null;
  return {
    totalBlocksAttempted: a,
    totalBlocksWon: w,
    winRate: n(r.winRate) ?? 0,
    totalMiningTime: n(r.totalMiningTime) ?? 0,
    avgMiningTime: n(r.avgMiningTime) ?? 0,
    headsObserved: n(r.headsObserved) ?? 0,
    contextsDispatched: n(r.contextsDispatched) ?? 0,
    resultsReceived: n(r.resultsReceived) ?? 0,
    proofsSubmitted: n(r.proofsSubmitted) ?? 0,
    staleDrops: n(r.staleDrops) ?? 0,
    submissionErrors: n(r.submissionErrors) ?? 0,
  };
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
  // SS58 of the locally polled quip-node. Persisted in `meta` so the server
  // can tell the UI which chain_miners entry is "us" without also knowing
  // QUIP_NODE_URL. Null until the indexer has completed its first status
  // poll after deploy.
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
  // All methods are filled by the substrate worker when QUIP_VALIDATOR_RPC_URL
  // is set on the indexer; otherwise the tables stay empty and reads return
  // null/[]. Each upsert is idempotent — a no-change call must be a no-op
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
  upsertChainMiners(miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>): Promise<void>;
  getChainMiners(): Promise<Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>>;

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
export const SCHEMA_VERSION = 6;

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
] as const;
