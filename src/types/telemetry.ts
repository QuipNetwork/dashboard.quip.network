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
 * /api/telemetry when no substrate connection has been established yet
 * (indexer hasn't received its first head from any URL in
 * QUIP_VALIDATOR_RPC_URLS).
 */
export interface ChainHead {
  bestBlockNumber: string;
  bestBlockHash: string;
  finalizedBlockNumber: string;
  finalizedBlockHash: string;
  // bestBlockNumber - finalizedBlockNumber, precomputed for the UI.
  finalityLag: number;
  // Latest monotonic qblock id (`quantum_pow.LatestQBlockId`) — equal to
  // the count of winning solutions accepted network-wide. This is the
  // authoritative source for the global "solution number": the in-flight
  // problem every miner is grinding is `winningSolutionsCount + 1`. Null
  // when the chain doesn't expose it yet or the substrate worker hasn't
  // read it. Equals `Σ chain_miners.proofsWon` when that table is complete,
  // but sourced straight from chain so it can't undercount.
  winningSolutionsCount: number | null;
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
 * Mirrors the upstream `controller` sub-object — the miner deprecated its
 * top-level totals (total_blocks_attempted / total_blocks_won / win_rate /
 * total_mining_time / avg_mining_time) in favor of these pipeline counters,
 * so the dashboard derives display aggregates from them (Submission Rate)
 * or from chain BlockRecords (Avg Mining Time).
 */
export interface MinerStats {
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
  // Results the miner produced but then discarded because they
  // duplicated a prior solution (same hash, same head). Visible on the
  // dashboard so operators can explain a `resultsReceived` >
  // `proofsSubmitted` gap without shelling into the miner. 0 for legacy
  // observability rows persisted before this field landed.
  duplicateResultDrops: number;
}

/**
 * Per-backend slice of the aggregated container snapshot. In a
 * single-process container `modes` is `{}` (no breakdown needed); in
 * a multi-process container (one quip-miner per active backend group)
 * there's one entry per active mode keyed by `cpu` / `gpu` / `qpu`.
 *
 * The aggregator sibling assembles this by reading each child's
 * `telemetry-stats-<kind>.json` and bucketing under its `mode` field
 * before merging the top-level counters. Operators reading the
 * dashboard see the unified numbers AND the per-backend breakdown
 * for "is the qpu doing anything?" investigations.
 */
export interface ModeBreakdown {
  // Subset of MinerStats counters that survive the per-process split
  // — only what the snapshot's `controller` block carries (pool /
  // chain heartbeat counters are container-wide and aggregated out
  // of this slice).
  headsObserved: number;
  contextsDispatched: number;
  resultsReceived: number;
  proofsSubmitted: number;
  staleDrops: number;
  submissionErrors: number;
  // Per-backend dedup count. Aggregator passes this through from the
  // child's `controller.duplicate_result_drops` so the per-mode table
  // matches the headline tile.
  duplicateResultDrops: number;
  // Worker handles this child owns (`{id, type}`). Lets the UI
  // show "cpu mode: 4 workers, qpu mode: 1 dwave handle" without
  // re-deriving from `miners[]` parsing.
  miners: Array<{ id: string; type: MinerCategory }>;
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
  // True only after a live /api/v1/status probe confirmed the local miner's
  // ss58. selfAddress set + selfIdentified false = configured (e.g. via
  // QUIP_OPERATOR_ACCOUNT) but miner unreachable — the otherwise-silent case.
  selfIdentified?: boolean;
  minerStats: MinerStats | null;
  // Per-backend breakdown from the multi-process aggregator's last
  // /api/v1/status response. `{}` for single-process miners. UI
  // renders one row per active mode under the headline counters so
  // operators can see "qpu produced 0 proofs in the last 10s while
  // cpu produced 5" without parsing miner ids.
  //
  // Optional so persisted v16 observability rows + existing test
  // fixtures parse cleanly; consumers default to `{}` when reading.
  modes?: Record<string, ModeBreakdown>;
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
 * `/api/v1/mining/attempts?solution_number=N` endpoint. The indexer fetches
 * one envelope per global `solution_number`, derives `attemptCount` and
 * `bestEnergyMilli` from the iterations array, and persists this row. The
 * full iteration trail is NOT persisted — the modal proxies fresh through
 * `GET /api/mining/attempts/:solutionNumber` when opened.
 *
 * Milli-unit fields (`*Milli`) preserve the chain's integer encoding for
 * lossless re-derivation; the UI divides by 1000 at display time.
 * `chainBlockNumber` / `chainBlockHash` / `extrinsicHash` are null until the
 * submission lands on-chain (outcome=`submitted_inblock` typically).
 */
export interface MiningSubmissionRecord {
  // Global chain solution number this submission was produced for
  // (`LatestQBlockId + 1`) at the time the miner opened the directory —
  // i.e. the network-wide problem index, durable and monotonic across
  // restarts. Every miner grinds the same global solution_number, so it's a
  // stable identity/sort key that no longer resets when the attempts dir is
  // moved.
  //
  // This is the key the modal proxies on
  // (`/api/v1/mining/attempts?solution_number=N`) and the DB primary
  // key. The "Sol #" column does NOT render this raw — it's chain-derived
  // from `chainBlockNumber ?? powSequence ?? solutionNumber`.
  solutionNumber: number;
  minerId: string;
  // Backend that produced this submission — CPU / CUDA / METAL / MODAL
  // / QPU. In multi-backend containers (one quip-miner process per
  // active config group) this is the only way to tell which backend
  // cleared the target for a given winning block. Empty string for
  // rows from miners that don't yet surface the field (older images
  // pre-dating the v17 telemetry plumbing).
  minerType: string;
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
  // On-chain `proofs_submitted` sequence at submit time (quip-protocol
  // MR !105), attached to non-winning submissions (rejected_stale /
  // chain_error). Winners carry `chainBlockNumber` instead — the two
  // are mutually exclusive by outcome (the controller records one or
  // the other), and the "Sol #" column reads whichever is present.
  // Null for winners and for pre-!105 miners that publish neither.
  powSequence: number | null;
  // Open enum: 'submitted_inblock' | 'rejected' | 'stored' | … — preserved
  // verbatim from the miner so future outcomes show up in the UI unchanged.
  outcome: string;
  attemptCount: number;
  // Derived: min(attempts[].best_energy_milli). Lets the table show "best
  // energy this submission ever reached" without unpacking iterations.
  bestEnergyMilli: number;
  // Count behind the Recent Performance "Solutions" column.
  //
  // Authoritative source (quip-protocol MR !105): the submission-level
  // `num_valid` field, recorded on every submission — the target-AWARE
  // count of unique samples meeting the energy threshold at submit time
  // (the count the chain accepts: ≥ min_solutions below max_energy).
  // !105 added this stable, per-submission value precisely so this
  // column no longer has to dig into the iteration trail.
  //
  // Fallback for pre-!105 envelopes: derived from the submitted
  // iteration's `solution_meta.n_unique_total` (!103+, the target-BLIND
  // sampler-productivity count), or the legacy per-iteration `num_valid`
  // for pre-!103 images. So the column reads "valid solutions meeting
  // target" for current miners and "sampler productivity" for ancient
  // ones — it converges on the former as the fleet upgrades.
  //
  // Distinct from the chain-side BlockRecord.numValidSolutions
  // (validator's count for a winning proof) and from the per-iter
  // below-threshold count (solution_meta.n_unique_below_threshold,
  // surfaced in the in-flight attempts panel). 0 when the miner
  // surfaced no count anywhere.
  numValid: number;
  // Per-submission sum of D-Wave's `qpu_access_time` across every
  // iteration of this submission (microseconds). Captures the *real*
  // time the QPU spent annealing + reading out — distinct from
  // wall-clock `mining_time_us`, which is dominated by D-Wave cloud
  // network round-trip + queue and so wildly overstates QPU compute.
  //
  // Requires the miner to surface `qpu_access_time_us` on each
  // iteration in its attempts JSONL output. Until that lands the
  // field reads 0 for new rows and existing rows after the v18 schema
  // wipe — operators see "—" or 0h on the QPU compute bar instead of
  // a wall-clock impostor.
  //
  // Always 0 for CPU/GPU miners — they have no quantum sampler and
  // their wall-clock mining time is the right metric for the
  // "compute used" chart.
  qpuAccessTimeUs: number;
  observedAt: string; // ISO 8601 when the indexer fetched this submission
  // True for UI-synthesized rows derived from a chain block when the
  // local mining_submissions table has no matching row (typical after
  // a miner restart that wiped its attempts log). Synthetic rows carry
  // chain-authoritative energy/diversity/numValid but no
  // `attemptCount` or genuine `solutionNumber` — the panel renders
  // em-dashes for those columns and disables modal click-through.
  // Never set by the server / DB layer; populated only in
  // `use-my-node`.
  chainOnly?: boolean;
}

/**
 * Per-iteration row inside a mining submission. Returned by the server's
 * `/api/mining/attempts/:solutionNumber` proxy on modal open. Not
 * persisted — the iteration trail can grow unbounded per submission so we
 * re-fetch fresh from the miner each time.
 *
 * `extra` carries the additional fields the miner returns beyond the
 * known shape (`ts_ns`, `solution_meta`, iteration timing, etc.) so the
 * modal can display them without the indexer/server having to know about
 * every field the miner adds in the future.
 */
export interface MiningAttempt {
  iter: number;
  bestEnergyMilli: number;
  // Open enum: 'rejected' | 'stored' | 'submitted' | … — preserved verbatim
  // from the miner's `result_kind` field.
  resultKind: string;
  // Backend that produced this iteration — hoisted from the JSONL's
  // `miner_type` field so the modal can show per-iteration backend
  // attribution without unpacking `extra`. Empty string for miners
  // that don't surface the field yet.
  minerType: string;
  extra: Record<string, unknown>;
}

/**
 * Envelope returned by `/api/mining/attempts/:solutionNumber`. Mirrors the
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
  // Substrate-derived snapshots. Null/empty when the substrate worker
  // hasn't connected to any endpoint in QUIP_VALIDATOR_RPC_URLS yet —
  // degrades gracefully to chain-less mode.
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
  // `MinerRegistry.NodeDescriptors`. Null when no descriptor has
  // been observed yet (fresh chain or pre-deploy operators). Drives the
  // Compute Available view's TFLOPS/PFLOPS surfaces.
  nodes: NodesSnapshot | null;
  // Per-account indexed descriptors — raw signed payloads plus provenance.
  // Empty when no `quip-miner identify` registry update has been seen. Drives
  // the Node Identities panel and joins into ChainMinersTable.
  nodeDescriptors: NodeDescriptorRecord[];
  // Recent submissions by the locally-polled miner, sourced from
  // `/api/v1/mining/attempts?solution_number=N` on the miner. Newest
  // first, capped at `RECENT_MINING_SUBMISSIONS_LIMIT` on the server.
  // Drives the "Recent Performance" panel — click a row to fetch the
  // iteration trail via `/api/mining/attempts/:solutionNumber`. Empty
  // when the miner has not submitted a proof since the indexer started
  // polling.
  recentMiningSubmissions: MiningSubmissionRecord[];
  // Lifetime count of distinct solution_numbers the indexer has recorded
  // for self where the iteration list was non-empty — drives the
  // "Problems Attempted" tile on the Mining Performance card. Counts
  // problems, not dispatches: a controller that re-dispatches the same
  // LastProofBlock won't double-count here. Zero until selfAddress
  // resolves or the indexer's first submission lands.
  selfProblemsAttempted: number;
  // The miner's work against the current global solution_number — either
  // the in-flight problem (status "in-flight", `solution_number =
  // Σ proofsWon + 1`, which the miner is actively grinding) or the
  // just-finished one (status "completed", `Σ proofsWon`) when the next
  // hasn't produced iterations yet. Null when the network has no wins
  // yet, or when both probes failed. The UI uses `status` to label the
  // panel header and joins `solutionNumber` against
  // `recentMiningSubmissions` to surface the chain outcome (e.g.
  // chain_error vs submitted_inblock).
  currentDispatch: CurrentDispatch | null;
}

export interface CurrentDispatch {
  // Global solution_number this iteration trail is grinding (MR !105):
  // `Σ proofsWon + 1` for the in-flight problem, or `Σ proofsWon` for the
  // just-completed one.
  solutionNumber: number;
  attempts: MiningAttempt[];
  status: "in-flight" | "completed";
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
