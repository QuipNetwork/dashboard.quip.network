// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  EpochId,
  EpochStatus,
  IndexerCursor,
  IndexerObservability,
  NodeInfo,
  NodeMinerEntry,
  NodeRuntime,
  NodeSystemGpu,
  NodeSystemInfo,
  NodesSnapshot,
  TelemetryIndex,
} from "../../src/types/telemetry";

/**
 * Runtime-validate a raw `indexer_observability` meta payload before casting.
 * The stored value is opaque TEXT in both adapters; shape drift (field rename,
 * nullability change, manual DB edit) would otherwise sail past TS's compile-
 * time types and produce NaN arithmetic downstream in `computeChainHealth`.
 *
 * Returns null on any parse or shape failure — the indexer overwrites on the
 * next poll, so a transient bad row shouldn't break the telemetry endpoint.
 * `source` is included in the warn so operators can tell sqlite from postgres.
 */
export function parseIndexerObservability(
  raw: string,
  source: "sqlite" | "postgres",
): IndexerObservability | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[db/${source}] corrupt indexer_observability (JSON parse): ${msg}`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    console.warn(`[db/${source}] corrupt indexer_observability: not an object`);
    return null;
  }
  const p = parsed as Record<string, unknown>;
  const isFiniteInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNullableStr = (v: unknown): v is string | null => v === null || isStr(v);
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  if (
    !isStr(p.nodeLatestEpoch) ||
    !isFiniteInt(p.nodeLatestBlockIndex) ||
    !isNullableStr(p.tipEpoch) ||
    !isFiniteInt(p.tipBlockIndex) ||
    !isNullableStr(p.backfillEpoch) ||
    !isFiniteInt(p.backfillBlockIndex) ||
    !isStr(p.lastStatusFetchAt) ||
    !isNullableStr(p.lastBlockInsertAt) ||
    !isNullableStr(p.nodesObservedAt) ||
    // v5 fields. A v4 blob (missing these) is rejected so the indexer's
    // next poll overwrites with a fresh v5 shape — same recovery pattern
    // as the cursor schema bump in v4.
    !isNullableStr(p.lastSubstrateEventAt) ||
    !isNullableStr(p.bestBlockHeight) ||
    !isNullableStr(p.finalizedBlockHeight) ||
    !isBool(p.chainConnected)
  ) {
    console.warn(`[db/${source}] corrupt indexer_observability: shape mismatch`);
    return null;
  }
  return {
    nodeLatestEpoch: p.nodeLatestEpoch,
    nodeLatestBlockIndex: p.nodeLatestBlockIndex,
    tipEpoch: p.tipEpoch,
    tipBlockIndex: p.tipBlockIndex,
    backfillEpoch: p.backfillEpoch,
    backfillBlockIndex: p.backfillBlockIndex,
    lastStatusFetchAt: p.lastStatusFetchAt,
    lastBlockInsertAt: p.lastBlockInsertAt,
    nodesObservedAt: p.nodesObservedAt,
    lastSubstrateEventAt: p.lastSubstrateEventAt,
    bestBlockHeight: p.bestBlockHeight,
    finalizedBlockHeight: p.finalizedBlockHeight,
    chainConnected: p.chainConnected,
  };
}

/**
 * Parse the meta[indexer_cursors] JSON. Returns null on any parse/shape
 * failure; the caller's fallback policy decides what to do (typically: treat
 * as "no cursors" and let both workers seed fresh).
 *
 * Naming mirrors `parseIndexerObservability` — the unsuffixed name is the
 * strict nullable variant. See `parseIndexerCursorsOrDefault` for the lenient
 * wrapper that substitutes fresh defaults on failure.
 */
export function parseIndexerCursors(
  raw: string | null,
): { tip: IndexerCursor; backfill: IndexerCursor; etags: { nodes: string | null } } | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const isCursor = (v: unknown): v is IndexerCursor => {
    if (typeof v !== "object" || v === null) return false;
    const c = v as Record<string, unknown>;
    return (
      (typeof c.epoch === "string" || c.epoch === null) &&
      typeof c.blockIndex === "number" &&
      Number.isFinite(c.blockIndex)
    );
  };
  if (!isCursor(p.tip) || !isCursor(p.backfill)) return null;
  // etags is optional but, when present, must be null or a plain object.
  // A string or array here indicates upstream corruption — fail the parse
  // rather than silently dropping to nodes:null, matching parseIndexerObservability.
  let nodes: string | null = null;
  if (p.etags !== undefined && p.etags !== null) {
    if (typeof p.etags !== "object" || Array.isArray(p.etags)) return null;
    const e = p.etags as Record<string, unknown>;
    if (e.nodes !== undefined && typeof e.nodes !== "string" && e.nodes !== null) return null;
    nodes = typeof e.nodes === "string" ? e.nodes : null;
  }
  return { tip: p.tip, backfill: p.backfill, etags: { nodes } };
}

/**
 * Like `parseIndexerCursors` but always returns a usable pair — fresh
 * defaults on any parse failure. Use in hot paths that just want "where
 * should the cursors seed?" without caring whether a prior blob existed.
 */
export function parseIndexerCursorsOrDefault(
  raw: string | null,
  source: "sqlite" | "postgres",
): { tip: IndexerCursor; backfill: IndexerCursor } {
  const fresh: IndexerCursor = { epoch: null, blockIndex: 0 };
  const parsed = parseIndexerCursors(raw);
  if (parsed) return { tip: parsed.tip, backfill: parsed.backfill };
  if (raw !== null) {
    console.warn(`[db/${source}] indexer_cursors missing or malformed; seeding fresh`);
  }
  return { tip: { ...fresh }, backfill: { ...fresh } };
}

export interface EpochStatusEntry {
  epoch: EpochId;
  status: EpochStatus;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;

  insertBlock(block: BlockRecord): Promise<boolean>;
  getAllBlocks(): Promise<BlockRecord[]>;
  getBlocksByEpoch(epoch: EpochId): Promise<BlockRecord[]>;
  getIndex(): Promise<TelemetryIndex>;

  // Replace the entire epoch_status table with this snapshot. Called once
  // per successful /api/v1/telemetry/epochs fetch. Writing the whole set
  // (rather than per-row upserting) keeps the DB in sync with the node when
  // a chain transitions live → stale_fork between polls.
  replaceEpochStatus(entries: EpochStatusEntry[]): Promise<void>;

  upsertNodes(snapshot: NodesSnapshot): Promise<number>;
  getNodes(): Promise<NodesSnapshot | null>;

  // Two-cursor persistence (replaces the old single-cursor getCursor/saveCursor).
  // Stored as a JSON blob in meta[indexer_cursors]; missing-key or parse failure
  // returns fresh {epoch:null, blockIndex:0} defaults for both cursors —
  // equivalent to a clean state.json wipe from the design spec.
  getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }>;
  saveCursors(
    tip: IndexerCursor,
    backfill: IndexerCursor,
    etags: { nodes?: string | null },
  ): Promise<void>;
  getEtags(): Promise<{ nodes: string | null }>;

  /** @internal test-only — write a raw value under a meta key. */
  setMetaRaw(key: string, value: string): Promise<void>;

  // Address of the quip-node this deployment polls. Persisted so the server
  // can tell the UI which entry in the nodes snapshot is "us" without also
  // knowing QUIP_NODE_URL. Null until the indexer has matched publicHost.
  getSelfAddress(): Promise<string | null>;
  setSelfAddress(address: string | null): Promise<void>;

  // Indexer/node tip observability. The indexer writes these on every
  // successful /api/v1/telemetry/status poll; the server reads them on
  // /api/telemetry so the UI can distinguish "no new blocks" from "indexer
  // falling behind". Null until the first successful poll after deploy.
  getIndexerObservability(): Promise<IndexerObservability | null>;
  setIndexerObservability(obs: IndexerObservability): Promise<void>;

  // --- Substrate-derived state (v5; targets quip-protocol-rs spec 101). ---
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

  // On-chain miner state from quantum_pow.Miners. The telemetry-node join
  // happens at read time in the server, not write time — keep this table
  // chain-pure.
  upsertChainMiners(miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>): Promise<void>;
  getChainMiners(): Promise<Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>>;

  // Append-only difficulty snapshots. Worker dedupes against most recent
  // before calling; ON CONFLICT DO NOTHING covers the race where two
  // workers see the same boundary block.
  insertDifficultySnapshot(snapshot: DifficultyRecord): Promise<void>;
  getRecentDifficulty(limit: number): Promise<DifficultyRecord[]>;

  // NULL-tolerant update of a single block row by (epoch, blockIndex).
  // COALESCE semantics: never clobbers a non-null with null unless the field
  // is explicitly being cleared (e.g., reorg). `finalized: true` is monotonic
  // — sets but never clears. Returns matched=false when the row doesn't
  // exist yet — caller queues for later replay via pendingWinnerEvents.
  updateBlockSubstrateFields(
    epoch: EpochId,
    blockIndex: number,
    fields: Partial<{
      substrateBlockNumber: string;
      substrateBlockHash: string;
      substrateParentHash: string;
      extrinsicsRoot: string;
      stateRoot: string;
      finalized: boolean;
    }>,
  ): Promise<{ matched: boolean }>;

  // Look up a candidate block by (minerId, energy). Used by the substrate
  // worker's BlockWinner-event correlation: when an event fires, find the
  // matching PoW BlockRecord. Returns the most recent match if multiple
  // exist (energy collisions across blocks are improbable for floats).
  findBlockByMinerAndEnergy(
    minerId: string,
    energy: number,
  ): Promise<{ epoch: EpochId; blockIndex: number } | null>;

  // Mark all blocks in the listed epochs as canonical=false (or true).
  // Used by the `epoch_status` swap path so dead-fork blocks never leak
  // into default reads (audit fix #5).
  markBlocksCanonical(epochs: EpochId[], canonical: boolean): Promise<void>;

  // Single-shot UPDATE of epoch_status.chain_anchor by epoch. Written by
  // the substrate worker once it has resolved which substrate block hash
  // anchors block_index=1 of that epoch.
  updateEpochChainAnchor(epoch: EpochId, chainAnchor: string): Promise<void>;
}

export interface DbConfig {
  adapter: "sqlite" | "postgres";
  databaseUrl?: string;
  sqlitePath?: string;
}

// Bump whenever any SCHEMA_STATEMENTS block in sqlite.ts / postgres.ts
// changes shape (add/drop column, add/drop table, add/drop index). On local
// deployments the adapter drops and recreates all tables on mismatch; on
// remote (production) deployments the mismatch is a no-op and the schema
// is expected to be managed externally.
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
// Drops vestigial `indexer_state` table. Operators on SQLite wipe
// `data/telemetry.db`; Postgres production runs the forward migration in
// `server/migrate.ts` (idempotent IF NOT EXISTS / IF EXISTS).
export const SCHEMA_VERSION = 5;

// Tables owned by this app. Listed explicitly so a drop-and-recreate can
// target exactly our data and never touch unrelated tables that may share
// a Postgres database.
export const OWNED_TABLES = [
  "blocks",
  "nodes_snapshot",
  "epoch_status",
  "meta",
  "chain_head",
  "babe_epochs",
  "babe_authorities",
  "chain_miners",
  "difficulty_history",
] as const;

const LOCAL_POSTGRES_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db", "postgres"]);

export function isLocalDeployment(config: DbConfig): boolean {
  if (config.adapter === "sqlite") return true;
  if (!config.databaseUrl) return false;
  try {
    return LOCAL_POSTGRES_HOSTS.has(new URL(config.databaseUrl).hostname);
  } catch {
    return false;
  }
}

// --- Raw node-API payloads (snake_case) ---
// Kept loose so we can ingest unknown fields without breaking. Only the
// fields we actually read are typed.

interface RawBlockPayload {
  block_index: number;
  block_hash: string;
  timestamp: number;
  previous_hash: string;
  miner: {
    miner_id: string;
    miner_type: string;
    ecdsa_public_key: string;
  };
  quantum_proof: {
    energy: number;
    diversity: number;
    num_valid_solutions: number;
    mining_time: number;
    nonce: number | string;
    num_nodes: number;
    num_edges: number;
  };
  requirements: {
    difficulty_energy: number;
    min_diversity: number;
    min_solutions: number;
  };
}

interface RawNodePayload {
  address: string;
  status: string;
  first_seen: number;
  last_seen: number;
  last_heartbeat: number | null;
  ecdsa_public_key_hex?: string;
  node_name?: string;
  public_host?: string;
  public_port?: number;
  auto_mine?: boolean;
  log_level?: string;
  runtime?: Record<string, unknown>;
  miners?: Record<string, Record<string, unknown>>;
  system_info?: Record<string, unknown>;
}

interface RawNodesPayload {
  updated_at: string;
  node_count: number;
  active_count: number;
  nodes: Record<string, RawNodePayload>;
}

// --- Converters: raw (snake_case) → internal (camelCase) ---

// miner.miner_type has drifted across node versions. Three observed shapes,
// all arriving as strings:
//   1. Current:    "CPU" | "GPU-LOCAL:0" | "QPU-DWAVE:0"  (category[-variant[:idx]])
//   2. Old:        '{"cpu": {...}, "gpu": null, "qpu": null}'       (capability map)
//   3. Middle:     '{"genesis_config": ..., "gpu": {...}, "cuda": {...}}'
//                  (whole node config accidentally dumped into the field)
// For (2) and (3) we JSON-parse and look for capability keys. Priority is
// QPU > GPU > CPU: when a miner advertises multiple capabilities we pick
// the highest since block payloads don't record which backend produced it.
const GPU_HINT_KEYS = ["gpu", "cuda", "metal"] as const;
const QPU_HINT_KEYS = ["qpu", "dwave"] as const;

function hasCapability(obj: Record<string, unknown>, key: string): boolean {
  return key in obj && obj[key] !== null && obj[key] !== undefined;
}

export function toMinerCategory(s: unknown): "CPU" | "GPU" | "QPU" {
  if (typeof s !== "string") throw new Error(`Unknown miner category: ${String(s)}`);
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      if (QPU_HINT_KEYS.some((k) => hasCapability(obj, k))) return "QPU";
      if (GPU_HINT_KEYS.some((k) => hasCapability(obj, k))) return "GPU";
      if (hasCapability(obj, "cpu")) return "CPU";
    } catch {
      // fall through to the segment scan
    }
  }
  // Scan every alphabetic segment. Compound strings like "CPU[1]+EXTERNAL[2]"
  // or "GPU-CUDA:0" describe multi-backend miners; when multiple backends are
  // present we prefer the highest-capability one since the block payload does
  // not record which backend actually produced this block.
  const segments = s
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  if (segments.includes("QPU")) return "QPU";
  if (segments.includes("GPU")) return "GPU";
  if (segments.includes("CPU")) return "CPU";
  throw new Error(`Unknown miner category: ${s.slice(0, 80)}`);
}

export function rawBlockToRecord(raw: RawBlockPayload, epoch: EpochId): BlockRecord {
  return {
    epoch,
    blockIndex: raw.block_index,
    blockHash: raw.block_hash,
    timestamp: raw.timestamp,
    previousHash: raw.previous_hash,
    minerId: raw.miner.miner_id,
    minerCategory: toMinerCategory(raw.miner.miner_type),
    ecdsaPublicKey: raw.miner.ecdsa_public_key,
    energy: raw.quantum_proof.energy,
    diversity: raw.quantum_proof.diversity,
    numValidSolutions: raw.quantum_proof.num_valid_solutions,
    miningTime: raw.quantum_proof.mining_time,
    nonce: String(raw.quantum_proof.nonce),
    numNodes: raw.quantum_proof.num_nodes,
    numEdges: raw.quantum_proof.num_edges,
    difficultyEnergy: raw.requirements.difficulty_energy,
    minDiversity: raw.requirements.min_diversity,
    minSolutions: raw.requirements.min_solutions,
    // Substrate fields are filled by substrate-worker post-insert; isCanonical
    // defaults to true and flips false via markBlocksCanonical when the
    // epoch_status swap detects a stale_fork.
    substrateBlockNumber: null,
    substrateBlockHash: null,
    substrateParentHash: null,
    extrinsicsRoot: null,
    stateRoot: null,
    finalized: false,
    isCanonical: true,
  };
}

function toRuntime(r: Record<string, unknown> | undefined): NodeRuntime | undefined {
  if (!r) return undefined;
  return {
    python: r.python as string | undefined,
    quipVersion: r.quip_version as string | undefined,
    protocolVersion: r.protocol_version as number | undefined,
    inDocker: r.in_docker as boolean | undefined,
    dockerImage: r.docker_image as string | undefined,
  };
}

function toMinerEntry(m: Record<string, unknown>): NodeMinerEntry {
  return {
    kind: toMinerCategory(m.kind),
    minerId: String(m.miner_id),
    numCpus: m.num_cpus as number | undefined,
    backend: m.backend as string | undefined,
    deviceIndex: m.device_index as number | undefined,
    utilization: m.utilization as number | undefined,
    provider: m.provider as string | undefined,
    solver: m.solver as string | undefined,
    dailyBudget: m.daily_budget as string | undefined,
  };
}

function toSystemInfo(s: Record<string, unknown> | undefined): NodeSystemInfo | undefined {
  if (!s) return undefined;
  const osRaw = s.os as Record<string, unknown> | undefined;
  const cpu = s.cpu as Record<string, unknown> | undefined;
  const gpus = s.gpus as Array<Record<string, unknown>> | undefined;
  return {
    os: osRaw
      ? {
          system: osRaw["system"] as string | undefined,
          release: osRaw["release"] as string | undefined,
          machine: osRaw["machine"] as string | undefined,
        }
      : undefined,
    cpu: cpu
      ? {
          logicalCores: cpu.logical_cores as number | undefined,
          physicalCores: cpu.physical_cores as number | undefined,
          brand: cpu.brand as string | undefined,
          arch: cpu.arch as string | undefined,
        }
      : undefined,
    memoryMb: s.memory_mb as number | undefined,
    gpus: gpus
      ? gpus.map<NodeSystemGpu>((g) => ({
          index: g.index as number | undefined,
          vendor: g.vendor as string | undefined,
          name: g.name as string | undefined,
          memoryMb: g.memory_mb as number | undefined,
          observedUtilizationPct: g.observed_utilization_pct as number | undefined,
        }))
      : undefined,
  };
}

function toNodeInfo(raw: RawNodePayload): NodeInfo {
  const miners: Record<string, NodeMinerEntry> = {};
  for (const [k, v] of Object.entries(raw.miners ?? {})) {
    miners[k] = toMinerEntry(v);
  }
  return {
    address: raw.address,
    status: raw.status,
    firstSeen: raw.first_seen,
    lastSeen: raw.last_seen,
    lastHeartbeat: raw.last_heartbeat,
    ecdsaPublicKeyHex: raw.ecdsa_public_key_hex,
    nodeName: raw.node_name,
    publicHost: raw.public_host,
    publicPort: raw.public_port,
    autoMine: raw.auto_mine,
    logLevel: raw.log_level,
    runtime: toRuntime(raw.runtime),
    miners: Object.keys(miners).length > 0 ? miners : undefined,
    systemInfo: toSystemInfo(raw.system_info),
  };
}

export function rawNodesToSnapshot(raw: RawNodesPayload): NodesSnapshot {
  const nodes: Record<string, NodeInfo> = {};
  for (const [addr, n] of Object.entries(raw.nodes)) {
    nodes[addr] = toNodeInfo(n);
  }
  return {
    updatedAt: raw.updated_at,
    nodeCount: raw.node_count,
    activeCount: raw.active_count,
    nodes,
  };
}
