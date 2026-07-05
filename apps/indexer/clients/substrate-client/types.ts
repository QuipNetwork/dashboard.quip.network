// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Type surface for the SubstrateClient abstraction. The production impl
// (PolkadotSubstrateClient) lives in substrate-client.ts; the test impl
// (FakeSubstrateClient) in fake-substrate-client.ts.

import type { NodeDescriptor } from "@quip/shared/telemetry";

export interface SubstrateHead {
  // u64 as string — substrate block heights exceed Number.MAX_SAFE_INTEGER
  // on long-running chains.
  number: string;
  hash: string;
  parentHash: string;
  extrinsicsRoot: string;
  stateRoot: string;
}

// Emitted by pallet-quantum-pow on_finalize. The substrate worker subscribes
// to system.events and filters for these.
//
// v0.2 field order (BlockWinner): qblock_id, block_number, miner, reward,
// energy_milli, submitted_at. The two leading fields are new in v0.2 — see
// `decodeBlockWinnerEventData` for the positional decode.
export interface BlockWinnerEvent {
  // Monotonic 1-based qblock id assigned in on_finalize when this proof
  // won. u64 as string. New in v0.2 (the network-wide "solution number").
  qblockId: string;
  // Substrate block number this win was sealed in (u64 as string). New in
  // v0.2; for the canonical writer this equals BlockEvents.blockNumber.
  blockNumber: string;
  miner: string; // SS58 account ID
  reward: string; // u128 as string
  energyMilli: number; // integer; divide by 1000 to compare to BlockRecord.energy
  submittedAt: string; // substrate block number (u64 as string)
}

// Emitted by pallet-quantum-pow on `submit_proof` (verified in
// quip-protocol-rs/pallets/quantum-pow/src/lib.rs:152-158). The substrate
// worker collects all proofs accepted within a finalized block alongside
// the single winning BlockWinner event so per-miner stats can be derived.
export interface ProofAcceptedEvent {
  miner: string; // SS58 account ID
  energyMilli: number; // signed integer; lower is better (more negative)
  diversityMilli: number;
  validSolutionCount: number;
}

// Aggregated per-finalized-block payload emitted by subscribeBlockEvents.
// v0.3 fires once per finalized block (not just winning blocks) so the
// worker can track validator authorship for every head. `winner` is null
// when the block carried no `quantumPow.BlockWinner` event; `author` is
// null only when BABE author derivation failed for that head.
// Timestamp is unix seconds (converted from substrate's millisecond
// timestamp.now).
export interface BlockEvents {
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  // SS58 account ID of the block author, extracted via api.derive.chain
  // (which reads the BABE digest item). `null` only when the chain didn't
  // include a recognised digest item — the worker treats this as "no
  // authorship to record" rather than fatal.
  author: string | null;
  timestamp: number; // unix seconds
  // `null` when the finalized block contained no winning proof. The worker
  // still observes the block (e.g., to record authorship) but skips the
  // canonical-block-writer path.
  winner: BlockWinnerEvent | null;
  proofs: ProofAcceptedEvent[];
  // u64 from the winning submit_proof extrinsic's proof.nonce, as a
  // decimal string. `null` means we could not locate a matching extrinsic
  // in the block (transient decode anomaly, signer/method mismatch, or
  // simply no winner) — distinct from the string "0", which is a legal
  // u64 value. The worker owns the policy decision (skip vs. default vs.
  // log).
  nonce: string | null;
}

// Aggregated topology counts derived from pallet-quantum-pow's
// DefaultTopology → RegisteredTopologies lookup (lib.rs:107-111). Pallet
// stores the actual nodes/edges vectors; the indexer only needs the
// cardinality to surface in /api/telemetry.
export interface TopologyInfo {
  nodeCount: number;
  edgeCount: number;
}

export interface BabeEpochInfo {
  epochIndex: number;
  currentSlot: string;
  epochStartSlot: string;
  // Constant from api.consts.babe.epochDuration. Typically 2400 on quip.
  slotsPerEpoch: number;
  authorityCount: number;
}

export interface RuntimeVersionInfo {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  implName: string;
}

// Thin BABE authority. quip-protocol-rs has no FRAME staking, so there's no
// commission/stake/nominator concept — just the account ID that has authority
// to author blocks in the current session.
export interface BabeAuthorityInfo {
  accountId: string;
  // Null on quip-protocol-rs spec 101 (no identity pallet enabled).
  displayName: string | null;
}

// On-chain miner state from pallet-quantum-pow's Miners storage.
export interface ChainMinerInfo {
  accountId: string;
  deposit: string;
  proofsSubmitted: string;
  proofsWon: string;
  rewardsEarned: string;
}

// Difficulty snapshot. v0.2 introduces `QuantumPowApi::current_difficulty()`
// which returns the live decayed value (the threshold the pallet currently
// checks proofs against); the raw `Difficulty` storage is the baseline that
// only changes when sudo updates it, so it can be hours stale during a
// decay window. The substrate worker converts to DifficultyRecord
// (milli → float) before DB write.
export interface DifficultyInfo {
  maxEnergyMilli: number;
  minDiversityMilli: number;
  minSolutions: number;
}

// Per-block winning solution snapshot returned by quip-protocol-rs v0.2's
// `QuantumPowApi::winning_solution(block_number)` runtime call. Carries both
// the winner (miner + energy + reward) AND the threshold the proof actually
// cleared (`difficulty`) AND the BLAKE3-derived nonce — meaning the worker
// no longer has to walk extrinsics to recover the nonce and no longer has
// to approximate the difficulty threshold from a separate poll.
export interface QBlockInfo {
  miner: string;
  energyMilli: number;
  reward: string;
  submittedAt: string;
  // U256 from BLAKE3((parent_hash, miner_blake2_256, block_number_u32,
  // salt_32bytes)), decimal-encoded. Replaces the v0.1 u64 nonce.
  nonce: string;
  difficulty: DifficultyInfo;
  // Spec-111 trailing QBlock field: miner-reported compute time for the
  // winning proof, in microseconds — D-Wave QPU access time for QPU wins,
  // wall clock for CPU/GPU. Self-reported (consensus never reads it).
  // `null` when the chain pre-dates runtime 111 (field absent from the
  // runtime API); `0` when present but unreported. Consumers must treat
  // both as "no report" and fall back to derived block spacing.
  deviceAccessTimeUs: number | null;
  // H256 (0x hex) of the topology this solution was mined against, carried
  // directly on the winning solution. Lets the winner-backfill path stamp
  // `blocks.topology_hash` from the already-fetched solution instead of a
  // per-block historical `DefaultTopology.at(hash)` runtime read. `null` when
  // the runtime value is absent (pre-topology era) or undecodable.
  topologyHash: string | null;
}

// Result of the targeted winner decode (`decodeWinnerBlock`): the block's
// events PLUS the single `winning_solution` fetch that produced them, threaded
// together so the dispatcher issues EXACTLY ONE `winningSolution` runtime call
// per winner block — the same `QBlockInfo` is reused for `ctx.qblock()` and its
// `topologyHash` for `ctx.defaultTopologyAt()` on the winner path.
export interface WinnerBlockDecode {
  events: BlockEvents;
  qblock: QBlockInfo | null;
}

// One topology on the chain's mineable whitelist, with its current decayed
// difficulty and node/edge counts. Sourced from the v0.2 QuantumPow runtime
// APIs `mineable_topologies()` + `difficulty_for(hash)` + `topology_meta(hash)`.
export interface MineableTopologyInfo {
  topologyHash: string;
  isDefault: boolean;
  difficulty: DifficultyInfo;
  nodeCount: number;
  edgeCount: number;
  // Energy-curve slope K (see MineableTopologyRecord.curveConstant), or null
  // when the topology's field/coupling specs aren't available.
  curveConstant: number | null;
}

export type UnsubFn = () => void;

// system_health + system_syncState snapshot (design 2026-07-04). isSyncing
// mirrors the node's major-sync flag; currentBlock/highestBlock are
// best-effort from system_syncState — null when that RPC is unavailable.
export interface SyncStateInfo {
  isSyncing: boolean;
  peers: number;
  currentBlock: number | null;
  highestBlock: number | null;
}

export interface SubstrateClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Node sync status for the indexer's sync gate. system_health is
  // required; system_syncState is best-effort. Throws on RPC failure —
  // the SyncGate keeps its last state on error (failure ≠ syncing).
  getSyncState(): Promise<SyncStateInfo>;

  // Connection lifecycle hooks. Used by the substrate worker to track
  // chainConnected for the SyncIndicator and to re-acquire subscriptions
  // after a reconnect.
  onConnected(cb: () => void): UnsubFn;
  onDisconnected(cb: () => void): UnsubFn;

  // Subscriptions. Each returns an UnsubFn the worker calls on shutdown
  // or before re-subscribing after a reconnect.
  subscribeFinalizedHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn>;
  subscribeNewHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn>;
  subscribeBlockWinnerEvents(cb: (e: BlockWinnerEvent) => void): Promise<UnsubFn>;

  // Aggregated per-block subscription used by the substrate worker as the
  // sole block writer. Fires once per finalized block that contained at
  // least one BlockWinner event; carries the winner, all sibling
  // ProofAccepted events, the block timestamp, and the nonce extracted
  // from the winning submit_proof extrinsic.
  subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn>;

  // Storage read at a specific historical block hash. Returns 0 when the
  // chain has never accepted a winning proof (matches the pallet's
  // ValueQuery default — see lib.rs:129).
  getLastProofBlockAt(blockHash: string): Promise<number>;

  // Current finalized head number via RPC (chain.getFinalizedHead +
  // getHeader). The reconciler's per-tick head source — never the persisted
  // observability value, which is stale after downtime (spec §5).
  getFinalizedHead(): Promise<string>;

  // Best-effort topology counts. Returns null when no default topology is
  // registered on the chain (lib.rs:111).
  getTopology(): Promise<TopologyInfo | null>;

  // H256 (0x hex) of the chain's `DefaultTopology` at `blockNumber`'s height,
  // read from historical state. Under model A (single active topology) this is
  // the topology a block at that height was won under — the source of truth for
  // tagging legacy blocks, since the qblock itself doesn't carry it. Null when
  // there was no default topology then, or the historical state is unavailable.
  getDefaultTopologyAt(blockNumber: string): Promise<string | null>;

  // Storage queries (poll path). Each returns null/empty when the
  // corresponding storage item is absent on the connected chain —
  // supports capability-detection so a missing pallet degrades to "no
  // data" rather than throwing.
  getBabeEpoch(): Promise<BabeEpochInfo | null>;
  getBabeAuthorities(): Promise<BabeAuthorityInfo[]>;
  getChainMiners(): Promise<ChainMinerInfo[]>;
  getDifficulty(): Promise<DifficultyInfo | null>;

  // v0.2: current per-topology difficulty for every topology on the mineable
  // whitelist (`mineable_topologies()` → `difficulty_for(hash)` +
  // `topology_meta(hash)`). Empty when the runtime APIs are absent (pre-v0.2).
  getMineableTopologies(): Promise<MineableTopologyInfo[]>;

  // v0.2: count of miners that declared participation on `qblockId` via
  // `MinerRegistry.participate` (the `participant_count_by_qblock` runtime
  // API). Null when the runtime API is absent (pre-v0.2 / pallet missing).
  getQBlockParticipantCount(qblockId: string): Promise<number | null>;

  getRuntimeVersion(): Promise<RuntimeVersionInfo>;
  getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null>;

  // Used by the worker after a BlockWinner event fires: look up the
  // substrate header at `submitted_at` to fill substrate_block_hash /
  // parent / roots.
  getBlockHeader(blockNumber: string): Promise<SubstrateHead | null>;

  // v0.2 runtime API. Returns the winning solution + nonce + per-block
  // difficulty snapshot persisted by `pallet-quantum-pow::on_finalize`.
  // Null when the block had no winner OR the chain pre-dates v0.2 (no
  // `quantumPowApi` runtime trait registered).
  getQBlock(blockNumber: string): Promise<QBlockInfo | null>;

  // Lists the block numbers (as decimal strings) for which a
  // `quantum_pow.QBlocks` entry exists on chain (v0.2 renamed the v0.1
  // `WinningSolutions` map). Used at indexer startup to backfill historical
  // wins that fired before `subscribeBlockEvents` started receiving live
  // heads. Returns empty when the storage map is absent (pre-v0.2) or empty
  // (no wins yet).
  getQBlockNumbers(): Promise<string[]>;

  // Network-wide winning-qblock total. v0.2 exposes this directly as the
  // `quantum_pow.QBlockCount` u64 (single O(1) read); falls back to counting
  // `QBlocks` keys. The global in-flight problem id is this + 1. Null when
  // neither item is present (pre-v0.2).
  getQBlockCount(): Promise<number | null>;

  // Decode events, author, and timestamp for a specific finalized block,
  // returning the same shape `subscribeBlockEvents` delivers on a live head.
  // Returns null when the block isn't found. Used by the startup backfill
  // path to route historical winning blocks through the worker's writer.
  processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null>;

  // Targeted winner-block decode used by the dispatcher for winner-only
  // backfill items: the block's events (author left null — authorship
  // backfills at the tip) plus the single `winning_solution` fetch that
  // produced them, WITHOUT `derive.chain.getBlock`. Returns null for a
  // non-winner block. See WinnerBlockDecode.
  decodeWinnerBlock(blockNumber: string): Promise<WinnerBlockDecode | null>;

  // Snapshot `miner_registry.NodeDescriptors` at a finalized block. The
  // runtime stores the descriptor's own `updated_at` block; returned rows
  // use that block for provenance so DB upserts are ordered by the actual
  // registry update, not by the later scan block. Returns null when the
  // requested block is not found on chain.
  getMinerRegistryDescriptorsAt(
    blockNumber: string,
  ): Promise<MinerRegistryDescriptorRecord[] | null>;
}

/**
 * One compact on-chain descriptor entry projected into the dashboard's
 * existing descriptor JSON shape, plus the chain provenance of the registry
 * update that produced it.
 */
export interface MinerRegistryDescriptorRecord {
  accountId: string;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: number;
  descriptor: NodeDescriptor;
}
