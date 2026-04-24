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
