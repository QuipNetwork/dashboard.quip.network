// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Types for v0.3 dashboard. The chain (quip-protocol-rs spec >=101) is the
// canonical source for per-block PoW data via the `quantum_pow` pallet's
// `BlockWinner` + `ProofAccepted` events. The miner's `/api/v1/status` /
// `/api/v1/system` / `/api/v1/stats` REST endpoints supply self-identity and
// aggregate counters only — there is no peer-aggregation surface in v0.2/v0.3.

export type MinerCategory = "CPU" | "GPU" | "QPU" | "OTHER";

export type MinerHardwareSource = "self" | "peer-query" | "chain";

/**
 * A PoW block as recorded by the dashboard. Substrate is the canonical source
 * in v0.3 — the substrate worker subscribes to quantum_pow's
 * `BlockWinner` + `ProofAccepted` event pairs (in `on_finalize`) and inserts
 * one row per substrate block whose PoW win is accepted. `blockHash` is the
 * PoW solution hash and serves as the table PK. All substrate_* fields are
 * populated at insert time — there is no two-phase enrichment in v0.3.
 */
export interface BlockRecord {
  blockHash: string;
  // u64 as string — substrate block heights kept as strings throughout the
  // dashboard for consistency and u64-precision safety. Indexer/UI convert to
  // Number for display/arithmetic at the boundary.
  substrateBlockNumber: string;
  substrateBlockHash: string;
  substrateParentHash: string;
  timestamp: number;
  minerId: string;
  energy: number;
  diversity: number;
  numValidSolutions: number;
  qualityMilli: number;
  miningTime: number;
  // u128 as string (token amount).
  reward: string;
  // u64 as string — nonce can exceed Number.MAX_SAFE_INTEGER.
  nonce: string;
  numNodes: number;
  numEdges: number;
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;
  finalized: boolean;
}

export interface RuntimeVersion {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  implName: string;
  // Block number (u64 as string) at which the active runtime was last
  // upgraded. Null when the chain has never upgraded since genesis.
  lastRuntimeUpgrade: string | null;
}

/**
 * Best/finalized substrate chain heads + runtime version. Single-row snapshot
 * written by the substrate worker on every head event (debounced). Null on
 * /api/telemetry when QUIP_VALIDATOR_RPC_URL is unset on the indexer.
 */
export interface ChainHead {
  bestBlockNumber: string;
  bestBlockHash: string;
  finalizedBlockNumber: string;
  finalizedBlockHash: string;
  // bestBlockNumber - finalizedBlockNumber, precomputed for the UI.
  finalityLag: number;
  runtime: RuntimeVersion;
  updatedAt: string;
}

/**
 * Substrate BABE epoch state — the substrate-chain consensus rotation concept,
 * slot-based, typically ~2400 slots / ~4h on quip-protocol-rs spec_version 101.
 */
export interface BabeEpochState {
  epochIndex: number;
  // u64 as string — BABE slot can exceed Number.MAX_SAFE_INTEGER on long-running chains.
  currentSlot: string;
  // u64 as string. The slot at which this epoch began.
  epochStartSlot: string;
  // Constant from `api.consts.babe.epochDuration`. Typically 2400 on quip.
  slotsPerEpoch: number;
  // currentSlot - epochStartSlot, precomputed for the UI progress bar.
  currentSlotInEpoch: number;
  // Number of BABE authorities active in this epoch. Sourced from
  // `api.query.session.validators().length` since BABE rotates per session.
  authorityCount: number;
}

/**
 * Thin record for a BABE authority. quip-protocol-rs spec 101 does not use
 * FRAME staking, so there is no commission/exposure/nominator concept — just
 * the account ID that has authority to author blocks in the current session.
 */
export interface BabeAuthorityRecord {
  accountId: string;
  // Optional display name from `api.query.identity.identityOf()` if the
  // identity pallet is enabled. Null on quip-protocol-rs spec 101.
  displayName: string | null;
}

/**
 * Rich on-chain miner state from `pallet-quantum-pow`'s `Miners` storage.
 * This is the high-value chain surface for the dashboard's mining audience.
 */
export interface ChainMinerRecord {
  accountId: string;
  // Token deposit locked by the miner to participate. u128 as string.
  deposit: string;
  // Lifetime counters. u64 as string.
  proofsSubmitted: string;
  proofsWon: string;
  // u128 as string (token amount).
  rewardsEarned: string;
  // Joined server-side from `miner_hardware.nodeId` when the chain account
  // matches a known hardware row. Today only self has a miner_hardware row
  // (source='self'); future peer-query/chain-surface versions populate other
  // entries.
  telemetryNodeAddress: string | null;
}

/**
 * Snapshot of `quantum_pow.Difficulty` at a specific substrate block.
 * Adjusted every `QuantumPowEpochLength` blocks (~100 = ~10min on spec 101).
 * Stored append-only in `difficulty_history` for the chart surface.
 *
 * Field names mirror BlockRecord (energy/diversity/solutions/quality) for
 * cross-table consistency. The substrate worker divides the chain's
 * `*_milli` integer encoding by 1000 before writing.
 */
export interface DifficultyRecord {
  // u64 as string — substrate block number at which this snapshot was taken.
  observedAtBlock: string;
  // From chain `max_energy_milli / 1000` — proof energy must be ≤ this.
  // Named `difficultyEnergy` to match the field on BlockRecord.
  difficultyEnergy: number;
  // From chain `min_diversity_milli / 1000`.
  minDiversity: number;
  // From chain `min_solutions` (already integer-units; no conversion).
  minSolutions: number;
  // From chain `min_quality_milli / 1000`. Surfaces a fourth dimension of
  // difficulty that BlockRecord doesn't track (proofs have a quality score
  // distinct from energy/diversity).
  minQuality: number;
  observedAt: string; // ISO 8601
}

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
 * Flattened from the upstream `controller` sub-object so the dashboard tiles
 * can read fields directly without re-shaping.
 */
export interface MinerStats {
  totalBlocksAttempted: number;
  totalBlocksWon: number;
  winRate: number;
  totalMiningTime: number;
  avgMiningTime: number;
  headsObserved: number;
  contextsDispatched: number;
  resultsReceived: number;
  proofsSubmitted: number;
  staleDrops: number;
  submissionErrors: number;
}

/**
 * Observability snapshot written by the indexer on every successful poll.
 * v0.3 drops the dual-cursor epoch/blockIndex model — the chain is now the
 * canonical block source, so we only track:
 *   - REST heartbeat: `lastStatusFetchAt` ticks every /api/v1/status poll.
 *   - Substrate heartbeat: `lastSubstrateEventAt` ticks on every head event.
 *   - `chainHeadFromNode`: best block height the locally polled quip-node
 *     reports via /api/v1/status.chain.head_number — null pre-first-fetch.
 *   - `minerStats`: latest /api/v1/stats payload, attached here so the UI
 *     can render miner tiles without a separate fetch.
 */
export interface IndexerObservability {
  // u64 as string — substrate block heights kept as strings throughout the
  // dashboard for consistency and u64-precision safety.
  chainHeadFromNode: string | null;
  lastStatusFetchAt: string; // ISO 8601
  lastBlockInsertAt: string | null;
  lastSubstrateEventAt: string | null;
  // Best/finalized substrate block heights, mirrored from chain_head for the
  // SyncIndicator. u64 as string. Null pre-first-event.
  bestBlockHeight: string | null;
  finalizedBlockHeight: string | null;
  // Live WSS socket state. Always false on a fresh process — only flips true
  // after the substrate worker's client emits a `connected` event.
  chainConnected: boolean;
  minerStats: MinerStats | null;
}

export interface TelemetryResponse {
  blocks: BlockRecord[];
  // SS58 of the locally polled quip-node, sourced from /api/v1/status.
  // Null until the indexer has completed its first successful poll.
  selfAddress: string | null;
  // Indexer/node tip observability. null before the indexer has completed
  // its first successful /status poll after deploy.
  indexer: IndexerObservability | null;
  // ISO 8601 timestamp the server stamped this response. Lets the UI
  // compute observability ages relative to server time, not client clock.
  serverTime: string;
  // Substrate-derived snapshots. Null/empty when QUIP_VALIDATOR_RPC_URL is
  // unset on the indexer — degrades gracefully to chain-less mode.
  chainHead: ChainHead | null;
  babeEpoch: BabeEpochState | null;
  babeAuthorities: BabeAuthorityRecord[];
  chainMiners: ChainMinerRecord[];
  // Recent DifficultyRecord snapshots (most recent first).
  recentDifficulty: DifficultyRecord[];
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
