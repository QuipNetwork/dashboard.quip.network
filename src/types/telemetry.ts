// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Types mirror the Quip node v0.1 telemetry REST API
// (/api/v1/telemetry/*). Field names are camelCase on our side; the indexer
// converts snake_case node payloads before storing.

export type MinerCategory = "CPU" | "GPU" | "QPU";

// Epoch IDs are 16-char hex hashes (e.g. "e0a08eef1dfff726") as of the node's
// post-timestamp-cutover telemetry. They're opaque strings end-to-end —
// never parse them to Number. Per-block time still lives in `timestamp`.
export type EpochId = string;

/**
 * Tag for `TelemetryIndex.epochs`: "live" is the single canonical-tip epoch
 * the node is currently extending; "stale_fork" is any indexed-but-abandoned
 * chain. Sourced from `/api/v1/telemetry/epochs`.
 */
export type EpochStatus = "live" | "stale_fork";

export interface BlockRecord {
  epoch: EpochId;
  blockIndex: number;
  blockHash: string;
  timestamp: number;
  previousHash: string;
  minerId: string;
  minerCategory: MinerCategory;
  ecdsaPublicKey: string;
  energy: number;
  diversity: number;
  numValidSolutions: number;
  miningTime: number;
  // u64 — exceeds Number.MAX_SAFE_INTEGER, stored/transported as string
  nonce: string;
  numNodes: number;
  numEdges: number;
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;

  // Substrate-side metadata (filled by substrate-worker; null until joined).
  // The join is via `quantum_pow.BlockWinner` events on quip-protocol-rs: the
  // event's `submitted_at` becomes substrateBlockNumber, then `chain.getBlock`
  // fills the rest. Lookup keyed by (minerId, energy) within the event payload.
  // u64 as string — substrate block heights exceed Number.MAX_SAFE_INTEGER.
  substrateBlockNumber: string | null;
  substrateBlockHash: string | null;
  substrateParentHash: string | null;
  extrinsicsRoot: string | null;
  stateRoot: string | null;
  // True once the substrate chain has finalized this PoW block's substrate
  // counterpart. Finality is monotonic — once true, never reverts.
  finalized: boolean;
  // False when this block is part of a stale_fork epoch. Default reads filter
  // this out unless a view explicitly opts in.
  isCanonical: boolean;
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
 * Substrate BABE epoch state. **Distinct from `EpochId` (PoW epoch)** — this
 * is the substrate-chain consensus rotation concept, slot-based, typically
 * ~2400 slots / ~4h on quip-protocol-rs spec_version 101.
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
  // Joined from the existing nodes snapshot when the chain account's ECDSA
  // pubkey matches a known telemetry node. Null when no match (chain account
  // isn't running a known node, or the chain hasn't published the mapping yet).
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

export interface NodeRuntime {
  python?: string;
  quipVersion?: string;
  protocolVersion?: number;
  inDocker?: boolean;
  dockerImage?: string;
}

export interface NodeSystemCpu {
  logicalCores?: number;
  physicalCores?: number;
  brand?: string;
  arch?: string;
}

export interface NodeSystemOs {
  system?: string;
  release?: string;
  machine?: string;
}

export interface NodeSystemGpu {
  index?: number;
  vendor?: string;
  name?: string;
  memoryMb?: number;
  observedUtilizationPct?: number;
}

export interface NodeSystemInfo {
  os?: NodeSystemOs;
  cpu?: NodeSystemCpu;
  memoryMb?: number;
  gpus?: NodeSystemGpu[];
}

export interface NodeMinerEntry {
  kind: MinerCategory;
  minerId: string;
  // CPU-only
  numCpus?: number;
  // GPU-only
  backend?: string;
  deviceIndex?: number;
  utilization?: number;
  // QPU-only
  provider?: string;
  solver?: string;
  dailyBudget?: string;
}

export interface NodeLocation {
  country: string;
  city?: string;
  lat: number;
  lng: number;
}

export interface NodeInfo {
  address: string;
  status: string;
  firstSeen: number;
  lastSeen: number;
  lastHeartbeat: number | null;
  ecdsaPublicKeyHex?: string;
  nodeName?: string;
  publicHost?: string;
  publicPort?: number;
  autoMine?: boolean;
  logLevel?: string;
  runtime?: NodeRuntime;
  miners?: Record<string, NodeMinerEntry>;
  systemInfo?: NodeSystemInfo;
  // Populated by the server from a GeoLite2 lookup on publicHost; absent when
  // no database is configured, DNS fails, or the IP is not in the DB.
  location?: NodeLocation;
}

export interface NodesSnapshot {
  updatedAt: string;
  nodeCount: number;
  activeCount: number;
  nodes: Record<string, NodeInfo>;
}

/**
 * Observability snapshot written by the indexer on every successful poll.
 * Lets the server + UI distinguish "node has no new blocks" from "node has
 * new blocks but the indexer is behind".
 *
 * - nodeLatestEpoch / nodeLatestBlockIndex: tip last reported by the node
 *   via /api/v1/telemetry/status.
 * - tipEpoch / tipBlockIndex: how far the tip-follower has actually
 *   persisted on status.latestEpoch's owned range. Equal to the node's
 *   tip when caught up.
 * - backfillEpoch / backfillBlockIndex: the epoch (and block within it)
 *   currently being walked by the backfill worker. Null epoch means the
 *   backfill plan has no outstanding work.
 * - lastStatusFetchAt: ISO timestamp of the most recent status response.
 *   Acts as an "indexer alive" heartbeat — if this is >minutes old, the
 *   indexer process has stopped or is wedged.
 * - lastBlockInsertAt: ISO timestamp of the most recent insertBlock. null
 *   if no block has been inserted since the indexer was last restarted.
 */
export interface IndexerObservability {
  nodeLatestEpoch: EpochId;
  nodeLatestBlockIndex: number;

  // Tip follower — cursor on status.latestEpoch's owned range.
  // tipEpoch === nodeLatestEpoch && tipBlockIndex === nodeLatestBlockIndex
  // means the tip is caught up.
  tipEpoch: EpochId | null;
  tipBlockIndex: number;

  // Backfill worker — null when no outstanding plan work; otherwise the
  // epoch currently being walked.
  backfillEpoch: EpochId | null;
  backfillBlockIndex: number;

  lastStatusFetchAt: string; // tip-worker heartbeat (ISO 8601)
  lastBlockInsertAt: string | null; // either worker's most recent insert

  // ISO 8601 timestamp of the most recent NON-304 `/api/v1/telemetry/nodes`
  // response — i.e. when we last got a fresh nodes snapshot from the node.
  // 304 (Not Modified) responses do NOT advance this, so a UI surfacing
  // node-data age can show "data N min old" even while the indexer is
  // actively polling (lastStatusFetchAt ticks every poll regardless).
  // Audit fix #6 — separates "indexer alive" from "nodes data fresh".
  // Null until the first 200 from /nodes after a restart.
  nodesObservedAt: string | null;

  // Substrate worker heartbeat (null when QUIP_VALIDATOR_RPC_URL is unset).
  // Most recent head event (new or finalized) received on the WSS subscription
  // or BlockWinner event from system.events. Anchors substrate health checks
  // in the SyncIndicator the same way lastStatusFetchAt anchors REST health.
  lastSubstrateEventAt: string | null;
  // Best/finalized substrate block heights, mirrored from chain_head for the
  // SyncIndicator. u64 as string. Null pre-first-event.
  bestBlockHeight: string | null;
  finalizedBlockHeight: string | null;
  // Live WSS socket state. Always false on a fresh process — only flips true
  // after the substrate worker's client emits a `connected` event.
  chainConnected: boolean;
}

export interface TelemetryResponse {
  blocks: BlockRecord[];
  nodes: NodesSnapshot;
  // Address of the quip-node this dashboard polls. Resolved by asking the
  // node for its own peer-list key via GET /api/v1/status. null until the
  // indexer has synced at least one nodes snapshot.
  selfAddress: string | null;
  // Indexer/node tip observability. null before the indexer has completed
  // its first successful /status poll after deploy.
  indexer: IndexerObservability | null;
  // ISO 8601 timestamp the server stamped this response. Lets the UI
  // compute observability ages relative to server time, not client clock —
  // fixes audit #3 (tab-visibility heartbeat skew).
  serverTime: string;
  // Substrate-derived snapshots. Null/empty when QUIP_VALIDATOR_RPC_URL is
  // unset on the indexer — degrades gracefully to PoW-only mode.
  chainHead: ChainHead | null;
  babeEpoch: BabeEpochState | null;
  babeAuthorities: BabeAuthorityRecord[];
  chainMiners: ChainMinerRecord[];
  // Recent DifficultyRecord snapshots (most recent first). Empty when no
  // substrate worker; populated by Phase 1.
  recentDifficulty: DifficultyRecord[];
}

export interface TelemetryIndex {
  epochs: Array<{
    epoch: EpochId;
    blockCount: number;
    status: EpochStatus;
    // Timestamp (unix seconds) of block_index=1 in this epoch. Drives the
    // "e0a08eef… · Apr 22 23:58" time cue in the EpochSelector. null when
    // the DB has rows for this epoch but not block 1 — possible on partial
    // mid-epoch backfills — in which case the UI renders the short hash only.
    firstBlockTimestamp: number | null;
  }>;
  lastUpdated: string;
}

export interface IndexerCursor {
  epoch: EpochId | null;
  blockIndex: number;
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
