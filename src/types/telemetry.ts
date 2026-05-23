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
  // Full hardware record joined server-side from `miner_hardware` when an
  // entry exists for this accountId. Null when no hardware data exists
  // (most miners today — only self is populated until peer-query lands).
  hardware: MinerHardwareRecord | null;
}

/**
 * Snapshot of `quantum_pow.Difficulty` at a specific substrate block.
 * Adjusted every `QuantumPowEpochLength` blocks (~100 = ~10min on spec 101).
 * Stored append-only in `difficulty_history` for the chart surface.
 *
 * Field names mirror BlockRecord (energy/diversity/solutions) for cross-table
 * consistency. The substrate worker divides the chain's `*_milli` integer
 * encoding by 1000 before writing.
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
  // Total dispatches that produced a result (= proofsSubmitted +
  // proofsUnverified). The right upper bound for the indexer's
  // mining_submissions catch-up — `proofsSubmitted` skips
  // chain-rejected submissions (outcome=chain_error), leaving them
  // un-indexed.
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

/**
 * Per-validator authorship payload joined against the active BABE authority
 * set. Each row corresponds to one BABE authority for the current session;
 * the server fills `blocksAuthored` / `blocksAuthoredWithPow` from the
 * `validator_authorship` aggregate table and computes `online` at read
 * time from `lastAuthoredAt`. Counters are 0 and timestamps are null for
 * authorities that have not yet authored a block the indexer has seen.
 */
export interface ValidatorAuthorshipRecord {
  accountId: string;
  blocksAuthored: number;
  blocksAuthoredWithPow: number;
  // Substrate block number of the most recent head this validator authored,
  // as a u64-as-string. Null until the indexer has observed at least one
  // authored head from this account.
  lastAuthoredBlock: string | null;
  // ISO 8601. Null when no authored head has been observed.
  lastAuthoredAt: string | null;
  // True when `lastAuthoredAt` is within the freshness window (3 minutes
  // at the time of writing). Computed server-side against the request
  // wall-clock so the SPA doesn't have to choose a clock.
  online: boolean;
}

/**
 * Operator-published node descriptor — the canonical identity record for
 * a miner, sourced from a `System.remark_with_event` extrinsic signed by
 * the operator's chain account. Shape mirrors `quip.node_descriptor.v1`
 * defined in `shared/system_info.py` on the miner side; see
 * `DASHBOARDPLAN.md` for the indexing spec. Dashboard-owned fields
 * (`address`, `firstSeen`, `lastSeen`) live on NodeInfo, not here —
 * descriptors are the operator's self-asserted side, joined at read time.
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
 * Geo-IP enrichment for a node's `publicHost`. Resolved server-side at
 * /api/telemetry time via DNS → MaxMind GeoLite2 (bundled or
 * GEOIP_DB_PATH override). Null/absent when:
 *   - `publicHost` is missing on the descriptor
 *   - DNS resolution fails (NXDOMAIN, timeout)
 *   - The resolved IP isn't in the geo database (private ranges,
 *     reserved blocks, MMDB miss)
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
  autoMine?: boolean;
  logLevel?: string;
  runtime?: NodeRuntime;
  miners?: Record<string, NodeMinerEntry>;
  systemInfo?: NodeSystemInfo;
  // Geo-IP enrichment of `publicHost`. Absent when the lookup failed or
  // when geo is disabled (no geoip-lite + no GEOIP_DB_PATH). The UI's
  // map silently omits markers for nodes without location.
  location?: NodeLocation;
}

export interface NodesSnapshot {
  updatedAt: string;
  nodeCount: number;
  activeCount: number;
  nodes: Record<string, NodeInfo>;
}

/**
 * Raw signed payload an operator emits via `quip-miner identify`. Field
 * names use camelCase (the indexer normalises from the chain's snake_case
 * JSON at decode time). Pass-through of `descriptorVersion` lets future
 * versions ride a parallel handler without mutating this shape.
 */
export interface NodeDescriptor {
  schema: "quip.node_descriptor.v1";
  descriptorVersion: 1;
  nodeName: string;
  publicHost?: string;
  publicPort?: number;
  rpcEndpoints?: string[];
  autoMine?: boolean;
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
 * Per-submission summary record sourced from the miner's
 * `/api/v1/mining/attempts?solution_id=N` endpoint. The indexer fetches one
 * envelope per controller-assigned `solution_id`, derives `attemptCount` and
 * `bestEnergyMilli` from the iterations array, and persists this row. The
 * full iteration trail is NOT persisted — the modal proxies fresh through
 * `GET /api/mining/attempts/:solutionId` when opened.
 *
 * Milli-unit fields (`*Milli`) preserve the chain's integer encoding for
 * lossless re-derivation; the UI divides by 1000 at display time.
 * `chainBlockNumber` / `chainBlockHash` / `extrinsicHash` are null until the
 * submission lands on-chain (outcome=`submitted_inblock` typically).
 */
export interface MiningSubmissionRecord {
  // Monotonic submission counter assigned by the miner's controller.
  // Distinct from chain `proofs_won` (only winners count there).
  solutionId: number;
  minerId: string;
  // Per-miner dispatch counter; multiple submissions can share a dispatch_id
  // when the controller batches grinding work.
  dispatchId: number;
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
  // Open enum: 'submitted_inblock' | 'rejected' | 'stored' | … — preserved
  // verbatim from the miner so future outcomes show up in the UI unchanged.
  outcome: string;
  attemptCount: number;
  // Derived: min(attempts[].best_energy_milli). Lets the table show "best
  // energy this submission ever reached" without unpacking iterations.
  bestEnergyMilli: number;
  // The `num_valid` count from the submitted iteration — how many of
  // the miner's sampled solutions passed validation. 0 when no submitted
  // iteration carried a count (chain_error before the count was known,
  // or older miners that didn't surface it). The chain-side equivalent
  // lives on BlockRecord.numValidSolutions.
  numValidSolutions: number;
  observedAt: string; // ISO 8601 when the indexer fetched this submission
}

/**
 * Per-iteration row inside a mining submission. Returned by the server's
 * `/api/mining/attempts/:solutionId` proxy on modal open. Not persisted —
 * the iteration trail can grow unbounded per submission so we re-fetch
 * fresh from the miner each time.
 *
 * `extra` carries the additional fields the miner returns beyond the
 * known shape (`dispatch_id`, dispatch timing, etc.) so the modal can
 * display them without the indexer/server having to know about every
 * field the miner adds in the future.
 */
export interface MiningAttempt {
  iter: number;
  bestEnergyMilli: number;
  // Open enum: 'rejected' | 'stored' | 'submitted' | … — preserved verbatim
  // from the miner's `result_kind` field.
  resultKind: string;
  extra: Record<string, unknown>;
}

/**
 * Envelope returned by `/api/mining/attempts/:solutionId`. Mirrors the
 * miner's response shape but with camelCase keys; the server proxies and
 * re-shapes via `parseMiningAttemptsApiResponse` in `api/miner-api.ts`.
 */
export interface MiningAttemptsResponse {
  submission: MiningSubmissionRecord;
  attempts: MiningAttempt[];
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
  // Active BABE authority set joined with per-validator authorship counters.
  // Empty when no BABE epoch has been polled yet.
  validators: ValidatorAuthorshipRecord[];
  // Snapshot of network nodes, projected server-side from the
  // `node_descriptors` table the indexer populates from
  // `System.remark_with_event` extrinsics. Null when no descriptor has
  // been observed yet (fresh chain or pre-deploy operators). Drives the
  // Compute Available view's TFLOPS/PFLOPS surfaces.
  nodes: NodesSnapshot | null;
  // Per-account indexed descriptors — raw signed payloads plus provenance.
  // Empty when no `quip-miner identify` extrinsic has been seen. Drives
  // the Node Identities panel and joins into ChainMinersTable.
  nodeDescriptors: NodeDescriptorRecord[];
  // Recent submissions by the locally-polled miner, sourced from
  // `/api/v1/mining/attempts?solution_id=N` on the miner. Newest first,
  // capped at `RECENT_MINING_SUBMISSIONS_LIMIT` on the server. Drives the
  // "Recent Performance" panel — click a row to fetch the iteration
  // trail via `/api/mining/attempts/:solutionId`. Empty when the miner
  // has not submitted a proof since the indexer started polling.
  recentMiningSubmissions: MiningSubmissionRecord[];
  // The miner's most recent dispatch — either the in-flight one (status
  // "in-flight" when `contextsDispatched + 1` has iterations) or the
  // just-completed one (status "completed", `contextsDispatched`). Null
  // when the miner hasn't dispatched anything yet, or when both probes
  // failed. The UI uses `status` to label the panel header and join
  // `dispatchId` against `recentMiningSubmissions` to surface the
  // chain outcome (e.g. chain_error vs submitted_inblock).
  currentDispatch: CurrentDispatch | null;
}

export interface CurrentDispatch {
  dispatchId: number;
  attempts: MiningAttempt[];
  status: "in-flight" | "completed";
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
