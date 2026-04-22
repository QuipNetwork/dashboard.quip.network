// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Types mirror the Quip node v0.1 telemetry REST API
// (/api/v1/telemetry/*). Field names are camelCase on our side; the indexer
// converts snake_case node payloads before storing.

export type MinerCategory = "CPU" | "GPU" | "QPU";

export interface BlockRecord {
  epoch: number;
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

export interface TelemetryResponse {
  blocks: BlockRecord[];
  nodes: NodesSnapshot;
  // Address of the quip-node this dashboard polls. Resolved by asking the
  // node for its own peer-list key via GET /api/v1/status. null until the
  // indexer has synced at least one nodes snapshot.
  selfAddress: string | null;
}

export interface TelemetryIndex {
  epochs: Array<{ epoch: number; blockCount: number }>;
  lastUpdated: string;
}

export interface IndexerCursor {
  epoch: number | null;
  blockIndex: number;
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
