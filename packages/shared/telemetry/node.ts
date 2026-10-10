// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MinerCategory } from "./miner";

/**
 * Operator-published node descriptor — the canonical identity record for
 * a miner, sourced from `MinerRegistry.NodeDescriptors` under the
 * operator's chain account. The runtime validates the compact
 * `quip.node_descriptor.v1` schema on write; the indexer projects it into
 * this dashboard shape. Dashboard-owned fields (`address`, `firstSeen`,
 * `lastSeen`) live on NodeInfo, not here.
 */
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

export interface NodeRuntime {
  python?: string;
  quipVersion?: string;
  protocolVersion?: number;
  inDocker?: boolean;
  dockerImage?: string;
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

/**
 * Geo-IP enrichment for a node's `publicHost`, resolved by the Rust server
 * each time it writes `nodes/snapshot.json` (every 30 seconds): host syntax
 * gate → DNS → city database at GEOIP_DB_PATH (DB-IP City Lite in the
 * image, GeoIP2-City schema). Null/absent when:
 *   - `publicHost` is missing on the descriptor
 *   - `publicHost` is not an IP literal or a DNS name (never queried)
 *   - DNS resolution fails (NXDOMAIN, timeout)
 *   - The resolved IP is private, loopback, link-local, or not in the
 *     database
 * `country` is an ISO-3166 alpha-2 code; "??" is a sentinel for "we got
 * a record but no country was set" (rare, but the MMDB schema permits it).
 */
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
  logLevel?: string;
  runtime?: NodeRuntime;
  miners?: Record<string, NodeMinerEntry>;
  systemInfo?: NodeSystemInfo;
  // Geo-IP enrichment of `publicHost`. Absent when the lookup failed or
  // when geo is disabled (no GEOIP_DB_PATH). The UI's map silently omits
  // markers for nodes without location.
  location?: NodeLocation;
}

export interface NodesSnapshot {
  updatedAt: string;
  nodeCount: number;
  activeCount: number;
  nodes: Record<string, NodeInfo>;
}

/**
 * Runtime-validated descriptor emitted via `quip-miner identify`. Field
 * names use camelCase after the indexer normalises the compact on-chain
 * storage value. Pass-through of `descriptorVersion` lets future versions
 * ride a parallel handler without mutating this shape.
 */
export interface NodeDescriptor {
  schema: "quip.node_descriptor.v1";
  descriptorVersion: 1;
  nodeName: string;
  publicHost?: string;
  publicPort?: number;
  rpcEndpoints?: string[];
  logLevel?: string;
  runtime?: NodeRuntime;
  miners?: Record<string, NodeMinerEntry>;
  systemInfo?: NodeSystemInfo;
}

/**
 * Indexed descriptor row — one per chain account, holding the most recent
 * valid payload plus provenance (block + extrinsic position used by the
 * upsert tie-breaker). `observedAt` is when the indexer wrote the row,
 * NOT when the extrinsic was signed; use `blockNumber` for chain-time.
 */
export interface NodeDescriptorRecord {
  accountId: string;
  blockNumber: string;
  blockHash: string;
  extrinsicIndex: number;
  // Block timestamp of the *most recent* descriptor for this account
  // (newer one wins on upsert).
  blockTimestamp: number;
  // Block timestamp of the *first* descriptor we ever observed for this
  // account — preserved across upserts so the NodeInfo projection can
  // populate `firstSeen` distinctly from `lastSeen`.
  firstBlockTimestamp: number;
  descriptor: NodeDescriptor;
  observedAt: string;
}

/**
 * The file-backed nodes document served at `/files/nodes/snapshot.json`.
 * `nodes` is a projection of `nodeDescriptors`, so the two travel together
 * in one file and the client fetches once. A writer task republishes it
 * every 30 seconds.
 */
export interface NodesDocument {
  nodes: NodesSnapshot | null;
  nodeDescriptors: NodeDescriptorRecord[];
}
