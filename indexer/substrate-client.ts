// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SubstrateClient interface: thin abstraction over the substrate RPC the
// indexer needs from `quip-protocol-rs` (BABE consensus + Grandpa finality
// + custom `pallet-quantum-pow`). The production impl
// (PolkadotSubstrateClient, this file) wraps `@polkadot/api`; the test
// impl (FakeSubstrateClient) is a programmable in-memory stand-in.
//
// Bundle isolation: `@polkadot/*` is imported only here. Anything in src/
// must never reach for substrate state directly — the worker pipes results
// through the indexer state and DB, and the SPA reads them via the server's
// /api/telemetry payload.

import type {
  MinerCategory,
  NodeDescriptor,
  NodeLogLevel,
  NodeMinerEntry,
  NodeRuntime,
  NodeSystemCpu,
  NodeSystemGpu,
  NodeSystemInfo,
  NodeSystemOs,
} from "../src/types/telemetry";

export interface SubstrateHead {
  // u64 as string — substrate block heights exceed Number.MAX_SAFE_INTEGER
  // on long-running chains.
  number: string;
  hash: string;
  parentHash: string;
  extrinsicsRoot: string;
  stateRoot: string;
}

// Emitted by pallet-quantum-pow on_finalize (verified in
// quip-protocol-rs/pallets/quantum-pow/src/lib.rs:328-335). The substrate
// worker subscribes to system.events and filters for these.
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
export interface WinningSolutionInfo {
  miner: string;
  energyMilli: number;
  reward: string;
  submittedAt: string;
  // U256 from BLAKE3((parent_hash, miner_blake2_256, block_number_u32,
  // salt_32bytes)), decimal-encoded. Replaces the v0.1 u64 nonce.
  nonce: string;
  difficulty: DifficultyInfo;
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
}

export type UnsubFn = () => void;

export interface SubstrateClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

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

  // Best-effort topology counts. Returns null when no default topology is
  // registered on the chain (lib.rs:111).
  getTopology(): Promise<TopologyInfo | null>;

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
  getWinningSolution(blockNumber: string): Promise<WinningSolutionInfo | null>;

  // Lists the block numbers (as decimal strings) for which a
  // `quantum_pow.QBlocks` entry exists on chain (v0.2 renamed the v0.1
  // `WinningSolutions` map). Used at indexer startup to backfill historical
  // wins that fired before `subscribeBlockEvents` started receiving live
  // heads. Returns empty when the storage map is absent (pre-v0.2) or empty
  // (no wins yet).
  getWinningBlockNumbers(): Promise<string[]>;

  // Network-wide winning-qblock total. v0.2 exposes this directly as the
  // `quantum_pow.QBlockCount` u64 (single O(1) read); falls back to counting
  // `QBlocks` keys. The global "solution number" the miner keys its
  // directories on is this + 1 (MR !105). Null when neither item is present
  // (pre-v0.2).
  getWinningSolutionsCount(): Promise<number | null>;

  // Decode events, author, and timestamp for a specific finalized block,
  // returning the same shape `subscribeBlockEvents` delivers on a live head.
  // Returns null when the block isn't found. Used by the startup backfill
  // path to route historical winning blocks through the worker's writer.
  processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null>;

  // Read every on-chain node descriptor from `MinerRegistry.NodeDescriptors`
  // (a StorageMap keyed by AccountId), decoded into the dashboard's shape.
  // v0.2 replaced the v0.1 `System.remark` JSON-descriptor flow with this
  // typed pallet storage, so the descriptor surface is now a full-storage
  // poll (like `getChainMiners`) rather than a per-block extrinsic scan.
  // Returns empty when the pallet is absent (pre-v0.2) or no descriptor has
  // been filed.
  getNodeDescriptors(): Promise<ChainNodeDescriptor[]>;
}

/**
 * One node descriptor read from `MinerRegistry.NodeDescriptors`. Carries the
 * chain-sourced parts only — the indexer's descriptor poll adds the observed
 * timestamps before persisting a `NodeDescriptorRecord`.
 */
export interface ChainNodeDescriptor {
  accountId: string;
  // On-chain `updated_at` block number (u64 as string).
  updatedAtBlock: string;
  // On-chain `payload_hash` (H256 hex).
  payloadHash: string;
  descriptor: NodeDescriptor;
}

/**
 * Programmable in-memory implementation for unit tests. Tests configure
 * the public fields (e.g. `babeEpoch`, `chainMiners`) and trigger
 * subscriptions via `emitFinalized` / `emitNew` / `emitBlockWinner`.
 *
 * `emitFinalized` and `emitNew` also stash the header so a later
 * `getBlockHeader(number)` returns it — mirrors the production behavior
 * where `chain_getBlockHash` can resolve any number the chain has seen.
 */
export class FakeSubstrateClient implements SubstrateClient {
  private connected = false;
  private connectedCbs = new Set<() => void>();
  private disconnectedCbs = new Set<() => void>();
  private finalizedCbs = new Set<(h: SubstrateHead) => void>();
  private newCbs = new Set<(h: SubstrateHead) => void>();
  private winnerCbs = new Set<(e: BlockWinnerEvent) => void>();
  private blockEventCbs = new Set<(e: BlockEvents) => void>();
  private headers = new Map<string, SubstrateHead>();

  public babeEpoch: BabeEpochInfo | null = null;
  public babeAuthorities: BabeAuthorityInfo[] = [];
  public chainMiners: ChainMinerInfo[] = [];
  public difficulty: DifficultyInfo | null = null;
  public lastProofBlockByHash = new Map<string, number>();
  public topology: TopologyInfo | null = null;
  // Keyed by blockNumber string. Tests populate this for the block(s) they
  // emit via `emitBlock`; the worker reads it back through
  // `getWinningSolution(blockNumber)` to source per-block difficulty and
  // nonce in BlockRecord construction.
  public winningSolutionsByBlock = new Map<string, WinningSolutionInfo>();
  public runtimeVersion: RuntimeVersionInfo = {
    specName: "quip",
    specVersion: 109,
    transactionVersion: 4,
    implName: "quip",
  };
  public lastRuntimeUpgrade: { blockNumber: string } | null = null;

  async connect(): Promise<void> {
    this.connected = true;
    for (const cb of this.connectedCbs) cb();
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    for (const cb of this.disconnectedCbs) cb();
  }
  isConnected(): boolean {
    return this.connected;
  }
  onConnected(cb: () => void): UnsubFn {
    this.connectedCbs.add(cb);
    return () => {
      this.connectedCbs.delete(cb);
    };
  }
  onDisconnected(cb: () => void): UnsubFn {
    this.disconnectedCbs.add(cb);
    return () => {
      this.disconnectedCbs.delete(cb);
    };
  }
  async subscribeFinalizedHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn> {
    this.finalizedCbs.add(cb);
    return () => {
      this.finalizedCbs.delete(cb);
    };
  }
  async subscribeNewHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn> {
    this.newCbs.add(cb);
    return () => {
      this.newCbs.delete(cb);
    };
  }
  async subscribeBlockWinnerEvents(cb: (e: BlockWinnerEvent) => void): Promise<UnsubFn> {
    this.winnerCbs.add(cb);
    return () => {
      this.winnerCbs.delete(cb);
    };
  }
  async subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn> {
    this.blockEventCbs.add(cb);
    return () => {
      this.blockEventCbs.delete(cb);
    };
  }
  async getLastProofBlockAt(blockHash: string): Promise<number> {
    return this.lastProofBlockByHash.get(blockHash) ?? 0;
  }
  async getTopology(): Promise<TopologyInfo | null> {
    return this.topology;
  }
  async getBabeEpoch(): Promise<BabeEpochInfo | null> {
    return this.babeEpoch;
  }
  async getBabeAuthorities(): Promise<BabeAuthorityInfo[]> {
    return this.babeAuthorities;
  }
  async getChainMiners(): Promise<ChainMinerInfo[]> {
    return this.chainMiners;
  }
  async getDifficulty(): Promise<DifficultyInfo | null> {
    return this.difficulty;
  }
  public mineableTopologies: MineableTopologyInfo[] = [];
  async getMineableTopologies(): Promise<MineableTopologyInfo[]> {
    return this.mineableTopologies;
  }
  // Keyed by qblock id string; tests populate the counts they expect to read.
  public qblockParticipantCounts = new Map<string, number>();
  async getQBlockParticipantCount(qblockId: string): Promise<number | null> {
    return this.qblockParticipantCounts.get(qblockId) ?? null;
  }
  async getRuntimeVersion(): Promise<RuntimeVersionInfo> {
    return this.runtimeVersion;
  }
  async getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null> {
    return this.lastRuntimeUpgrade;
  }
  async getBlockHeader(blockNumber: string): Promise<SubstrateHead | null> {
    return this.headers.get(blockNumber) ?? null;
  }
  async getWinningSolution(blockNumber: string): Promise<WinningSolutionInfo | null> {
    return this.winningSolutionsByBlock.get(blockNumber) ?? null;
  }
  async getWinningBlockNumbers(): Promise<string[]> {
    return [...this.winningSolutionsByBlock.keys()];
  }
  async getWinningSolutionsCount(): Promise<number | null> {
    return this.winningSolutionsByBlock.size;
  }
  // Tests populate `historicalBlocks` (keyed by blockNumber string) for any
  // historical winning block the backfill loop should be able to fetch.
  public historicalBlocks = new Map<string, BlockEvents>();
  async processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null> {
    return this.historicalBlocks.get(blockNumber) ?? null;
  }
  // Tests populate `nodeDescriptors` with the chain descriptors the
  // descriptor poll should observe.
  public nodeDescriptors: ChainNodeDescriptor[] = [];
  async getNodeDescriptors(): Promise<ChainNodeDescriptor[]> {
    return this.nodeDescriptors;
  }

  emitFinalized(h: SubstrateHead): void {
    this.headers.set(h.number, h);
    for (const cb of this.finalizedCbs) cb(h);
  }
  emitNew(h: SubstrateHead): void {
    this.headers.set(h.number, h);
    for (const cb of this.newCbs) cb(h);
  }
  emitBlockWinner(e: BlockWinnerEvent): void {
    for (const cb of this.winnerCbs) cb(e);
  }
  emitBlock(e: BlockEvents): void {
    for (const cb of this.blockEventCbs) cb(e);
  }
  setHeader(h: SubstrateHead): void {
    this.headers.set(h.number, h);
  }
}

// ---------------------------------------------------------------------------
// Production implementation
// ---------------------------------------------------------------------------

import { ApiPromise, WsProvider } from "@polkadot/api";
import { GenericExtrinsicSignatureV4 } from "@polkadot/types/extrinsic/v4/ExtrinsicSignature";
import { GenericExtrinsicSignatureV5 } from "@polkadot/types/extrinsic/v5/ExtrinsicSignature";

// quip-protocol-rs replaces stock `MultiSignature` with `HybridTxSignature`
// (a plain `{public: [u8;1344], signature: [u8;2484]}` struct — see
// quip-protocol-rs/crates/transaction-crypto/src/lib.rs). The chain's V16
// metadata exposes the type at `quip_transaction_crypto::HybridTxSignature`
// (type id 106 on spec 101) and polkadot.js auto-resolves
// `ExtrinsicSignature` to it via the metadata lookup. We do NOT need to
// register the type ourselves.
//
// However: polkadot.js v16.5.6's `GenericExtrinsicSignatureV{4,5}` computes
// `isSigned` from `!this.signature.isEmpty`, which only works for the stock
// `MultiSignature` enum (empty bytes → no variant → isEmpty=true). For our
// concrete (non-enum) struct signature, default bytes are 1344+2484 zeros
// — non-empty — so isSigned is incorrectly always true. That cascades into
// `GenericExtrinsic.version` throwing "Signed Extrinsics are currently only
// available for ExtrinsicV4" even for V5 *unsigned* timestamp inherents.
//
// The fix: subclass the V4/V5 signature codecs and track `isSigned` from
// the constructor option (which polkadot.js sets correctly from the
// extrinsic's preamble byte) instead of inferring it from field bytes.
class HybridExtrinsicSignatureV4 extends GenericExtrinsicSignatureV4 {
  #isExplicitlySigned: boolean;
  // The base class' constructor signature uses positional args we forward
  // as-is; the third arg is `{ isSigned }`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(registry: any, value: unknown, opts: { isSigned?: boolean } = {}) {
    super(registry, value as never, opts as never);
    this.#isExplicitlySigned = Boolean(opts.isSigned);
  }
  override get isSigned(): boolean {
    return this.#isExplicitlySigned;
  }
}

class HybridExtrinsicSignatureV5 extends GenericExtrinsicSignatureV5 {
  #isExplicitlySigned: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(registry: any, value: unknown, opts: { isSigned?: boolean } = {}) {
    super(registry, value as never, opts as never);
    this.#isExplicitlySigned = Boolean(opts.isSigned);
  }
  override get isSigned(): boolean {
    return this.#isExplicitlySigned;
  }
}

/**
 * @polkadot/api-backed implementation. Pinned to 16.5.6 in package.json so
 * @polkadot/types stays in lockstep (a mismatch produces opaque decode
 * errors). Storage queries target quip-protocol-rs v0.2 (spec_version 109) —
 * later runtime upgrades may rename items; capability checks (`?.`)
 * keep the worker non-fatal in that case.
 */
export class PolkadotSubstrateClient implements SubstrateClient {
  private api: ApiPromise | null = null;
  private provider: WsProvider | null = null;
  private connectedCbs = new Set<() => void>();
  private disconnectedCbs = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async connect(): Promise<void> {
    // autoConnect = false: our substrate-worker owns the reconnect loop
    // (exponential backoff with jitter). WsProvider's built-in reconnect
    // uses a fixed interval which doesn't match our policy. WITH
    // autoConnect=false, the constructor does NOT initiate the socket —
    // we must call provider.connect() ourselves, otherwise ApiPromise.create
    // waits forever for a "connected" event that never fires.
    this.provider = new WsProvider(this.url, false, undefined, this.timeoutMs);
    this.provider.on("connected", () => {
      for (const cb of this.connectedCbs) cb();
    });
    this.provider.on("disconnected", () => {
      for (const cb of this.disconnectedCbs) cb();
    });
    await this.provider.connect();
    this.api = await ApiPromise.create({ provider: this.provider, throwOnConnect: true });
    // Override extrinsic signature codecs so that polkadot.js v16's
    // `isSigned` derivation works with quip's `HybridTxSignature` struct.
    // See HybridExtrinsicSignatureV{4,5} above for the rationale.
    // The polkadot.js type for `register(name, class)` is `CodecClass`, but
    // our subclass extends `Struct` (which IS a CodecClass at runtime); the
    // generic signature is too tight to accept a `Struct` subclass directly.
    type AnyCodecClass = Parameters<typeof this.api.registry.register>[1];
    this.api.registry.register(
      "ExtrinsicSignatureV4",
      HybridExtrinsicSignatureV4 as unknown as AnyCodecClass,
    );
    this.api.registry.register(
      "ExtrinsicSignatureV5",
      HybridExtrinsicSignatureV5 as unknown as AnyCodecClass,
    );
  }

  async disconnect(): Promise<void> {
    const api = this.api;
    this.api = null;
    this.provider = null;
    if (api) await api.disconnect();
  }

  isConnected(): boolean {
    return this.provider?.isConnected ?? false;
  }

  onConnected(cb: () => void): UnsubFn {
    this.connectedCbs.add(cb);
    return () => {
      this.connectedCbs.delete(cb);
    };
  }
  onDisconnected(cb: () => void): UnsubFn {
    this.disconnectedCbs.add(cb);
    return () => {
      this.disconnectedCbs.delete(cb);
    };
  }

  private requireApi(): ApiPromise {
    if (!this.api) throw new Error("[substrate-client] not connected");
    return this.api;
  }

  async subscribeFinalizedHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    const unsub = await api.rpc.chain.subscribeFinalizedHeads((header) => {
      cb({
        number: header.number.toString(),
        hash: header.hash.toHex(),
        parentHash: header.parentHash.toHex(),
        extrinsicsRoot: header.extrinsicsRoot.toHex(),
        stateRoot: header.stateRoot.toHex(),
      });
    });
    return () => {
      unsub();
    };
  }

  async subscribeNewHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    const unsub = await api.rpc.chain.subscribeNewHeads((header) => {
      cb({
        number: header.number.toString(),
        hash: header.hash.toHex(),
        parentHash: header.parentHash.toHex(),
        extrinsicsRoot: header.extrinsicsRoot.toHex(),
        stateRoot: header.stateRoot.toHex(),
      });
    });
    return () => {
      unsub();
    };
  }

  async subscribeBlockWinnerEvents(cb: (e: BlockWinnerEvent) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    const eventsQuery = api.query.system?.events;
    if (!eventsQuery) {
      // `system.events` is a baseline substrate capability — if it's gone,
      // the chain is so broken (or the api client so misconfigured) that
      // silently returning a no-op unsub would hide it forever. Throw so
      // the reconnect loop logs + backs off; the operator can then see
      // that block-winner attribution is unwired.
      throw new Error(
        "[substrate-client] api.query.system.events is unavailable; cannot subscribe to BlockWinner events",
      );
    }
    // Subscribes to ALL events; filter to quantumPow.BlockWinner. Event
    // shape (v0.2): (qblock_id: u64, block_number: BlockNumber, miner:
    // AccountId, reward: Balance, energy_milli: i64, submitted_at:
    // BlockNumber). Verified against
    // quip-protocol-rs/pallets/quantum-pow/src/lib.rs:328-335. Positional
    // decode lives in `decodeBlockWinnerEventData`.
    type EventRecord = {
      event: {
        section: string;
        method: string;
        data: Array<{ toString: () => string }>;
      };
    };
    const unsub = await eventsQuery((records: EventRecord[]) => {
      for (const record of records) {
        const { event } = record;
        if (event.section !== "quantumPow" || event.method !== "BlockWinner") continue;
        const decoded = decodeBlockWinnerEventData(event.data);
        if (decoded) cb(decoded);
      }
    });
    return () => {
      (unsub as unknown as () => void)();
    };
  }

  async getBabeEpoch(): Promise<BabeEpochInfo | null> {
    const api = this.requireApi();
    if (!api.query.babe?.epochIndex || !api.query.babe?.currentSlot) return null;
    const [epochIndexCodec, currentSlotCodec] = await Promise.all([
      api.query.babe.epochIndex(),
      api.query.babe.currentSlot(),
    ]);
    const slotsPerEpochConst = api.consts.babe?.epochDuration;
    if (!slotsPerEpochConst) return null;
    const slotsPerEpoch = Number(slotsPerEpochConst.toString());
    const epochIndex = Number(epochIndexCodec.toString());
    const currentSlot = currentSlotCodec.toString();
    // epoch_start_slot is not directly exposed by stock BABE; derive from
    // epoch_index * slots_per_epoch which is exact when no epoch was skipped.
    const epochStartSlot = (BigInt(epochIndex) * BigInt(slotsPerEpoch)).toString();
    const authorityCount = (await this.getBabeAuthorities()).length;
    return { epochIndex, currentSlot, epochStartSlot, slotsPerEpoch, authorityCount };
  }

  async getBabeAuthorities(): Promise<BabeAuthorityInfo[]> {
    const api = this.requireApi();
    // `session.validators` is the only authoritative source: it returns the
    // full hybrid AccountIds that join against `quantumPow.miners` and
    // `validator_authorship`. The legacy `babe.authorities` fallback returned
    // the 1344-byte BABE pubkey instead, which doesn't join — keeping it
    // around just made the Chain tab appear non-empty against the wrong
    // identifiers. Throw loudly so a misconfigured chain surfaces in indexer
    // logs immediately.
    if (!api.query.session?.validators) {
      throw new Error(
        "[substrate-client] api.query.session.validators is unavailable; " +
          "indexer requires quip-protocol-rs >= v0.2 (pallet-session integrated).",
      );
    }
    const codec = await api.query.session.validators();
    const list = codec as unknown as Array<{ toString: () => string }>;
    return list.map((id) => ({ accountId: id.toString(), displayName: null }));
  }

  async getChainMiners(): Promise<ChainMinerInfo[]> {
    const api = this.requireApi();
    if (!api.query.quantumPow?.miners) return [];
    const entries = await api.query.quantumPow.miners.entries();
    const out: ChainMinerInfo[] = [];
    for (const [key, value] of entries) {
      const accountId = key.args[0]!.toString();
      // MinerInfo struct from pallet-quantum-pow/src/types.rs:57-67.
      // polkadot.js exposes Rust field names in camelCase via codec.toJSON;
      // we read via toHuman/toJSON for reliable field access.
      const json = (value as unknown as { toJSON: () => Record<string, unknown> }).toJSON();
      out.push({
        accountId,
        deposit: String(json.deposit ?? "0"),
        proofsSubmitted: String(json.proofsSubmitted ?? json.proofs_submitted ?? "0"),
        proofsWon: String(json.proofsWon ?? json.proofs_won ?? "0"),
        rewardsEarned: String(json.rewardsEarned ?? json.rewards_earned ?? "0"),
      });
    }
    return out;
  }

  async getDifficulty(): Promise<DifficultyInfo | null> {
    const api = this.requireApi();
    // Prefer the v0.2 runtime API: it applies on-the-fly decay so the
    // returned value reflects the threshold the pallet actually checks
    // proofs against (not the stored baseline, which only refreshes on
    // sudo updates and can be hours stale through a decay window).
    const runtimeFn = (api.call as unknown as Record<string, Record<string, unknown> | undefined>)
      ?.quantumPowApi?.currentDifficulty;
    if (typeof runtimeFn === "function") {
      const codec = await (runtimeFn as () => Promise<unknown>)();
      return decodeDifficulty(codec);
    }
    // Capability fallback for pre-v0.2 chains. Drop in a follow-up MR
    // once the deployed chain is stable on the new runtime API.
    if (!api.query.quantumPow?.difficulty) return null;
    const codec = await api.query.quantumPow.difficulty();
    return decodeDifficulty(codec);
  }

  async getMineableTopologies(): Promise<MineableTopologyInfo[]> {
    const api = this.requireApi();
    const call = api.call as unknown as Record<string, Record<string, unknown> | undefined>;
    const listFn = call?.quantumPowApi?.mineableTopologies;
    if (typeof listFn !== "function") return []; // pre-v0.2 runtime
    const listCodec = await (listFn as () => Promise<unknown>)();
    const hashes = (listCodec as { toJSON?: () => unknown }).toJSON?.();
    if (!Array.isArray(hashes)) return [];

    // Resolve the default topology hash so each entry can be flagged.
    let defaultHash: string | null = null;
    const dt = api.query.quantumPow?.defaultTopology;
    if (dt) {
      const opt = (await dt()) as { isSome?: boolean; unwrap?: () => { toHex: () => string } };
      if (opt?.isSome && opt.unwrap) defaultHash = opt.unwrap().toHex();
    }

    const diffFn = call?.quantumPowApi?.difficultyFor;
    const metaFn = call?.quantumPowApi?.topologyMeta;
    const out: MineableTopologyInfo[] = [];
    for (const raw of hashes) {
      const topologyHash = String(raw);
      let difficulty: DifficultyInfo = {
        maxEnergyMilli: 0,
        minDiversityMilli: 0,
        minSolutions: 0,
      };
      if (typeof diffFn === "function") {
        const dc = (await (diffFn as (h: string) => Promise<unknown>)(topologyHash)) as {
          isSome?: boolean;
          unwrap?: () => unknown;
        };
        if (dc?.isSome && dc.unwrap) difficulty = decodeDifficulty(dc.unwrap());
      }
      let nodeCount = 0;
      let edgeCount = 0;
      if (typeof metaFn === "function") {
        const mc = (await (metaFn as (h: string) => Promise<unknown>)(topologyHash)) as {
          isSome?: boolean;
          unwrap?: () => { nodes: { length: number }; edges: { length: number } };
        };
        if (mc?.isSome && mc.unwrap) {
          const meta = mc.unwrap();
          nodeCount = meta.nodes.length;
          edgeCount = meta.edges.length;
        }
      }
      out.push({
        topologyHash,
        isDefault: topologyHash === defaultHash,
        difficulty,
        nodeCount,
        edgeCount,
      });
    }
    return out;
  }

  async getQBlockParticipantCount(qblockId: string): Promise<number | null> {
    const api = this.requireApi();
    const fn = (api.call as unknown as Record<string, Record<string, unknown> | undefined>)
      ?.minerRegistryApi?.participantCountByQblock;
    if (typeof fn !== "function") return null; // pre-v0.2 / pallet absent
    const codec = await (fn as (id: string) => Promise<unknown>)(qblockId);
    const n = Number((codec as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  async getRuntimeVersion(): Promise<RuntimeVersionInfo> {
    const api = this.requireApi();
    const rv = api.runtimeVersion;
    return {
      specName: rv.specName.toString(),
      specVersion: rv.specVersion.toNumber(),
      transactionVersion: rv.transactionVersion.toNumber(),
      implName: rv.implName.toString(),
    };
  }

  async getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null> {
    const api = this.requireApi();
    if (!api.query.system?.lastRuntimeUpgrade) return null;
    const codec = await api.query.system.lastRuntimeUpgrade();
    const opt = codec as unknown as {
      isSome?: boolean;
      unwrap?: () => Record<string, { toString: () => string }>;
    };
    if (!opt.isSome || !opt.unwrap) return null;
    const inner = opt.unwrap();
    // lastRuntimeUpgrade is `Option<LastRuntimeUpgradeInfo>` with
    // {spec_version, spec_name}. We want the block number it happened at —
    // which isn't actually in this storage; the storage tells you what
    // version was installed, not when. Surface specVersion in lieu of
    // blockNumber; the substrate worker uses it as an upgrade-trigger
    // sentinel, not a block reference.
    return { blockNumber: String(inner.specVersion?.toString() ?? "0") };
  }

  async getBlockHeader(blockNumber: string): Promise<SubstrateHead | null> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    if (hashCodec.isEmpty) return null;
    const signed = await api.rpc.chain.getBlock(hashCodec);
    const header = signed.block.header;
    return {
      number: header.number.toString(),
      hash: header.hash.toHex(),
      parentHash: header.parentHash.toHex(),
      extrinsicsRoot: header.extrinsicsRoot.toHex(),
      stateRoot: header.stateRoot.toHex(),
    };
  }

  async getWinningSolution(blockNumber: string): Promise<WinningSolutionInfo | null> {
    const api = this.requireApi();
    const fn = (api.call as unknown as Record<string, Record<string, unknown> | undefined>)
      ?.quantumPowApi?.winningSolution;
    if (typeof fn !== "function") return null;
    const codec = await (fn as (n: string) => Promise<unknown>)(blockNumber);
    // WinningSolutionWithNonce is `Option<{solution: WinningSolution, nonce: U256}>`.
    const opt = codec as {
      isSome?: boolean;
      unwrap?: () => Record<string, unknown>;
    };
    if (!opt.isSome || !opt.unwrap) return null;
    const wrapped = opt.unwrap();
    const solRaw = wrapped.solution ?? wrapped["solution"];
    if (!solRaw) return null;
    // polkadot.js may surface struct fields as codec instances; coerce via
    // toJSON for the primitive view we need.
    const sol =
      typeof (solRaw as { toJSON?: () => unknown }).toJSON === "function"
        ? ((solRaw as { toJSON: () => Record<string, unknown> }).toJSON() as Record<
            string,
            unknown
          >)
        : (solRaw as Record<string, unknown>);
    const nonceCodec = wrapped.nonce;
    const nonce =
      typeof (nonceCodec as { toString?: () => string })?.toString === "function"
        ? (nonceCodec as { toString: () => string }).toString()
        : String(nonceCodec ?? "0");
    return {
      miner: String(sol.miner),
      energyMilli: Number(sol.energyMilli ?? sol.energy_milli ?? 0),
      reward: String(sol.reward),
      submittedAt: String(sol.submittedAt ?? sol.submitted_at ?? "0"),
      nonce,
      difficulty: decodeDifficulty(sol.difficulty),
    };
  }

  async subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    // Finalized-only subscription via the bare `api.rpc.chain.subscribeFinalizedHeads`.
    // We previously used `api.derive.chain.subscribeFinalizedHeads` (which gap-fills
    // skipped heads when finalization jumps ahead), but its callback was
    // silently never invoked against quip-protocol-rs v0.2 chains — finalizedBlockHeight
    // updated fine via the bare RPC subscription, but the derive wrapper
    // ate every head. The bare subscription is what every other path in this
    // file already uses; per-block enrichment (author + events) still happens
    // via `derive.chain.getBlock(hash)` inside the callback through
    // `decodeFinalizedBlock`, so the eventual shape is unchanged.
    const unsubFn = await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      try {
        const events = await this.decodeFinalizedBlock(
          header.hash.toHex(),
          header.parentHash.toHex(),
          header.number.toNumber(),
        );
        if (events) cb(events);
      } catch (e) {
        // Contain per-block failures so a transient RPC blip (getBlock
        // timeout, decode mishap, downstream cb throw) doesn't let the
        // rejection escape into polkadot.js — which is version-dependent
        // and in the worst case silently degrades the subscription. The
        // next finalized head fires normally.
        const num = header.number.toNumber();
        console.warn(`[substrate-client] subscribeBlockEvents block ${num} failed`, e);
      }
    });
    return () => {
      (unsubFn as unknown as () => void)();
    };
  }

  async getWinningBlockNumbers(): Promise<string[]> {
    const api = this.requireApi();
    // v0.2 renamed the winning-solution storage: WinningSolutions → QBlocks
    // (StorageMap keyed by substrate block number, lib.rs:275). Capability
    // check covers pre-v0.2 chains where neither item exists.
    if (!api.query.quantumPow?.qBlocks?.entries) return [];
    const entries = (await api.query.quantumPow.qBlocks.entries()) as unknown as Array<
      [{ args: Array<{ toString: () => string }> }, unknown]
    >;
    return entries.map(([key]) => key.args[0]!.toString());
  }

  async getWinningSolutionsCount(): Promise<number | null> {
    const api = this.requireApi();
    const q = api.query.quantumPow;
    // v0.2 exposes `QBlockCount` (u64 ValueQuery, lib.rs:280) — the
    // network-wide count of winning qblocks, i.e. the global "solution
    // number". Prefer it: a single O(1) storage read instead of scanning
    // every QBlocks key. (Replaces the v0.1 WinningSolutions map + its
    // CountedStorageMap companion.)
    const countFn = (q as Record<string, unknown> | undefined)?.["qBlockCount"] as
      | { (): Promise<{ toString: () => string }> }
      | undefined;
    if (typeof countFn === "function") {
      const raw = await countFn();
      const n = Number(raw.toString());
      if (Number.isFinite(n)) return n;
    }
    // Fallback: count QBlocks keys (one paged scan). Null on pre-v0.2
    // chains where neither QBlockCount nor QBlocks exists.
    if (!q?.qBlocks?.keys) return null;
    const keys = (await q.qBlocks.keys()) as unknown as unknown[];
    return keys.length;
  }

  async processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    const blockHash = hashCodec.toHex();
    // BlockHash("0x00…00") is the chain_getBlockHash sentinel for
    // "block not found"; nothing to decode.
    if (/^0x0+$/.test(blockHash)) return null;
    const header = await api.rpc.chain.getHeader(hashCodec);
    return this.decodeFinalizedBlock(blockHash, header.parentHash.toHex(), Number(blockNumber));
  }

  // Shared decoder for both live finalized heads (via subscribe) and
  // historical backfill blocks (via processFinalizedBlock). Pulls
  // SignedBlockExtended (author + events + extrinsics) plus the block's
  // timestamp inherent, parses out BlockWinner / ProofAccepted events, and
  // resolves the winner's nonce via the v0.2 runtime API. Throws on RPC
  // failures so the caller can decide how to surface them.
  private async decodeFinalizedBlock(
    blockHash: string,
    parentHash: string,
    blockNumber: number,
  ): Promise<BlockEvents | null> {
    const api = this.requireApi();
    const timestampAt = api.query.timestamp?.now?.at;
    if (!timestampAt) {
      throw new Error("[substrate-client] runtime missing timestamp.now");
    }
    if (!api.derive.chain?.getBlock) {
      throw new Error("[substrate-client] api.derive.chain.getBlock is unavailable");
    }
    const [signedBlockExt, timestampAtBlock] = await Promise.all([
      api.derive.chain.getBlock(blockHash),
      timestampAt(blockHash),
    ]);
    const author = signedBlockExt.author ? signedBlockExt.author.toString() : null;

    type EventRecord = {
      event: {
        section: string;
        method: string;
        data: Array<{ toString: () => string }>;
      };
    };
    let winner: BlockWinnerEvent | null = null;
    const proofs: ProofAcceptedEvent[] = [];
    for (const rec of signedBlockExt.events as unknown as EventRecord[]) {
      const { section, method, data } = rec.event;
      if (section !== "quantumPow") continue;
      if (method === "BlockWinner") {
        const decoded = decodeBlockWinnerEventData(data);
        if (decoded) winner = decoded;
      } else if (method === "ProofAccepted") {
        const [minerCodec, energyCodec, diversityCodec, validCodec] = data;
        if (!minerCodec || !energyCodec || !diversityCodec || !validCodec) continue;
        proofs.push({
          miner: minerCodec.toString(),
          energyMilli: Number(energyCodec.toString()),
          diversityMilli: Number(diversityCodec.toString()),
          validSolutionCount: Number(validCodec.toString()),
        });
      }
    }
    // Nonce sourced from quip-protocol-rs v0.2's
    // `QuantumPowApi::winning_solution(block)` — the runtime computes the
    // BLAKE3 digest server-side. Null for winnerless heads (no fetch
    // performed) and for chains pre-v0.2 (capability absent).
    const nonce = winner
      ? ((await this.getWinningSolution(String(blockNumber)))?.nonce ?? null)
      : null;
    return {
      blockNumber,
      blockHash,
      parentHash,
      author,
      // pallet_timestamp returns milliseconds; the indexer stores unix
      // seconds (BlockRecord.timestamp) for parity with the legacy REST
      // path. Truncate rather than round to keep ordering stable.
      timestamp: Math.floor(
        Number((timestampAtBlock as unknown as { toString: () => string }).toString()) / 1000,
      ),
      winner,
      proofs,
      nonce,
    };
  }

  async getLastProofBlockAt(blockHash: string): Promise<number> {
    const api = this.requireApi();
    // Verified storage item: quip-protocol-rs/pallets/quantum-pow/src/lib.rs:129
    // LastProofBlock: StorageValue<_, BlockNumberFor<T>, ValueQuery> → u32/u64.
    if (!api.query.quantumPow?.lastProofBlock) return 0;
    const codec = await api.query.quantumPow.lastProofBlock.at(blockHash);
    return Number(codec.toString());
  }

  async getNodeDescriptors(): Promise<ChainNodeDescriptor[]> {
    const api = this.requireApi();
    // v0.2: descriptors live in MinerRegistry.NodeDescriptors (StorageMap
    // keyed by AccountId). Capability check covers chains without the pallet.
    const map = api.query.minerRegistry?.nodeDescriptors;
    if (!map?.entries) return [];
    const entries = (await map.entries()) as unknown as Array<
      [{ args: Array<{ toString: () => string }> }, { toJSON: () => unknown }]
    >;
    const out: ChainNodeDescriptor[] = [];
    for (const [key, value] of entries) {
      const accountId = key.args[0]?.toString();
      if (!accountId) continue;
      const json = value.toJSON();
      if (!json || typeof json !== "object") continue;
      out.push(mapChainDescriptor(accountId, json as Record<string, unknown>));
    }
    return out;
  }

  async getTopology(): Promise<TopologyInfo | null> {
    const api = this.requireApi();
    // No singleton "RegisteredTopology" exists on the pallet. The chain
    // exposes DefaultTopology: Option<H256> (lib.rs:111) pointing into
    // RegisteredTopologies: StorageMap<H256, TopologyMeta> (lib.rs:107).
    // We materialise (node_count, edge_count) by reading the default
    // topology's TopologyMeta and counting its nodes/edges vectors.
    if (!api.query.quantumPow?.defaultTopology || !api.query.quantumPow?.registeredTopologies) {
      return null;
    }
    const defaultCodec = await api.query.quantumPow.defaultTopology();
    const defaultOpt = defaultCodec as unknown as {
      isSome?: boolean;
      unwrap?: () => { toHex: () => string };
    };
    if (!defaultOpt.isSome || !defaultOpt.unwrap) return null;
    const topologyHash = defaultOpt.unwrap().toHex();
    const metaCodec = await api.query.quantumPow.registeredTopologies(topologyHash);
    const metaOpt = metaCodec as unknown as {
      isSome?: boolean;
      unwrap?: () => { nodes: { length: number }; edges: { length: number } };
    };
    if (!metaOpt.isSome || !metaOpt.unwrap) return null;
    const meta = metaOpt.unwrap();
    return {
      nodeCount: meta.nodes.length,
      edgeCount: meta.edges.length,
    };
  }
}

/**
 * Decode a `quantumPow.BlockWinner` event's positional `data` array into a
 * {@link BlockWinnerEvent}. The v0.2 event carries six fields in order:
 * `[qblock_id, block_number, miner, reward, energy_milli, submitted_at]`
 * (quip-protocol-rs/pallets/quantum-pow/src/lib.rs:328-335) — two more than
 * the v0.1 shape, which the indexer used to read as `[miner, reward,
 * energy_milli, submitted_at]`. Returns null when the data is truncated
 * (decode anomaly) so callers skip rather than write a misaligned row.
 *
 * Extracted (and exported) so the positional decode can be unit-tested
 * without a live chain — the Fake client emits already-decoded events.
 */
export function decodeBlockWinnerEventData(
  data: Array<{ toString: () => string }>,
): BlockWinnerEvent | null {
  const [qblockIdCodec, blockNumberCodec, minerCodec, rewardCodec, energyCodec, submittedAtCodec] =
    data;
  if (
    !qblockIdCodec ||
    !blockNumberCodec ||
    !minerCodec ||
    !rewardCodec ||
    !energyCodec ||
    !submittedAtCodec
  ) {
    return null;
  }
  return {
    qblockId: qblockIdCodec.toString(),
    blockNumber: blockNumberCodec.toString(),
    miner: minerCodec.toString(),
    reward: rewardCodec.toString(),
    energyMilli: Number(energyCodec.toString()),
    submittedAt: submittedAtCodec.toString(),
  };
}

// Note: the v0.1-era `extractNonce` helper that walked extrinsics to
// recover the winning miner's nonce is gone in v0.2 — `WinningSolutionInfo`
// (sourced from `QuantumPowApi::winning_solution`) carries the BLAKE3 nonce
// directly, so subscribeBlockEvents calls `getWinningSolution(...)`
// instead. Less brittle: no dependency on extrinsic decoding or the custom
// HybridTxSignature codec.

/**
 * Decode a polkadot.js `Bytes` field surfaced via `.toJSON()` (a 0x-prefixed
 * hex string) into UTF-8. Tolerates an already-plain string (returned as-is)
 * and returns undefined for null/empty/odd-length input so optional
 * descriptor fields stay absent rather than blank.
 */
function bytesToString(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  if (!v.startsWith("0x")) return v;
  const cleaned = v.slice(2);
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return undefined;
  const u8 = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    u8[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(u8);
  } catch {
    return undefined;
  }
}

// Map the on-chain MinerKind enum variant (Cpu | Gpu | QpuDwave | QpuIbm |
// QpuIonq | QpuPasqal | Asic) to the dashboard's coarse MinerCategory.
function mapMinerKind(v: unknown): MinerCategory {
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("cpu")) return "CPU";
  if (s.startsWith("gpu")) return "GPU";
  if (s.startsWith("qpu")) return "QPU";
  return "OTHER";
}

// Map the on-chain LogLevel enum variant to NodeLogLevel; undefined when the
// value isn't a recognised variant.
function mapLogLevel(v: unknown): NodeLogLevel | undefined {
  switch (String(v ?? "").toLowerCase()) {
    case "debug":
      return "Debug";
    case "info":
      return "Info";
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function finiteNumberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Decode the optional schema-v2 `runtime` (node-software) block. String
// fields are `Bytes` (hex via toJSON); protocolVersion is a number, inDocker
// a bool. Returns undefined for absent/non-object input (None / schema-v1).
function mapRuntime(v: unknown): NodeRuntime | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: NodeRuntime = {};
  const python = bytesToString(r.python);
  const quipVersion = bytesToString(r.quipVersion);
  const protocolVersion = finiteNumberOrUndef(r.protocolVersion);
  const dockerImage = bytesToString(r.dockerImage);
  if (python !== undefined) out.python = python;
  if (quipVersion !== undefined) out.quipVersion = quipVersion;
  if (protocolVersion !== undefined) out.protocolVersion = protocolVersion;
  if (typeof r.inDocker === "boolean") out.inDocker = r.inDocker;
  if (dockerImage !== undefined) out.dockerImage = dockerImage;
  return out;
}

// Decode the optional schema-v2 `system_info` hardware survey. Every string
// field is a `Bytes` (hex via toJSON); numeric fields pass through. Returns
// undefined for absent/non-object input (schema-v1 descriptors).
function mapSystemInfo(v: unknown): NodeSystemInfo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: NodeSystemInfo = {};

  const osRaw = r.os as Record<string, unknown> | null | undefined;
  if (osRaw && typeof osRaw === "object") {
    const os: NodeSystemOs = {};
    const system = bytesToString(osRaw.system);
    const release = bytesToString(osRaw.release);
    const machine = bytesToString(osRaw.machine);
    if (system !== undefined) os.system = system;
    if (release !== undefined) os.release = release;
    if (machine !== undefined) os.machine = machine;
    out.os = os;
  }

  const cpuRaw = r.cpu as Record<string, unknown> | null | undefined;
  if (cpuRaw && typeof cpuRaw === "object") {
    const cpu: NodeSystemCpu = {};
    const logicalCores = finiteNumberOrUndef(cpuRaw.logicalCores);
    const physicalCores = finiteNumberOrUndef(cpuRaw.physicalCores);
    const brand = bytesToString(cpuRaw.brand);
    const arch = bytesToString(cpuRaw.arch);
    if (logicalCores !== undefined) cpu.logicalCores = logicalCores;
    if (physicalCores !== undefined) cpu.physicalCores = physicalCores;
    if (brand !== undefined) cpu.brand = brand;
    if (arch !== undefined) cpu.arch = arch;
    out.cpu = cpu;
  }

  const memoryMb = finiteNumberOrUndef(r.memoryMb);
  if (memoryMb !== undefined) out.memoryMb = memoryMb;

  const gpusRaw = Array.isArray(r.gpus) ? r.gpus : [];
  if (gpusRaw.length > 0) {
    out.gpus = gpusRaw.map((g) => {
      const gr = (g ?? {}) as Record<string, unknown>;
      const gpu: NodeSystemGpu = {};
      const index = finiteNumberOrUndef(gr.index);
      const vendor = bytesToString(gr.vendor);
      const name = bytesToString(gr.name);
      const gpuMem = finiteNumberOrUndef(gr.memoryMb);
      const util = finiteNumberOrUndef(gr.utilizationPct);
      if (index !== undefined) gpu.index = index;
      if (vendor !== undefined) gpu.vendor = vendor;
      if (name !== undefined) gpu.name = name;
      if (gpuMem !== undefined) gpu.memoryMb = gpuMem;
      if (util !== undefined) gpu.utilizationPct = util;
      return gpu;
    });
  }

  return out;
}

/**
 * Map a `MinerRegistry.NodeDescriptor` storage value (as surfaced by
 * polkadot.js `.toJSON()`) into a {@link ChainNodeDescriptor}. Pure and
 * exported so the V1/V2 field mapping can be unit-tested without a live
 * chain. `Bytes` fields arrive as hex and are decoded to UTF-8; enum
 * variants are normalised case-insensitively; `None` options arrive as null
 * and drop out as absent optionals.
 */
export function mapChainDescriptor(
  accountId: string,
  raw: Record<string, unknown>,
): ChainNodeDescriptor {
  const schemaVersion: 1 | 2 = raw.schemaVersion === 2 ? 2 : 1;

  const minersRaw = Array.isArray(raw.miners) ? raw.miners : [];
  const miners: NodeMinerEntry[] = minersRaw.map((m) => {
    const mm = (m ?? {}) as Record<string, unknown>;
    const entry: NodeMinerEntry = { kind: mapMinerKind(mm.kind) };
    const label = bytesToString(mm.label);
    const backend = bytesToString(mm.backend);
    const deviceId = bytesToString(mm.deviceId);
    if (label !== undefined) entry.label = label;
    if (backend !== undefined) entry.backend = backend;
    if (deviceId !== undefined) entry.deviceId = deviceId;
    return entry;
  });

  const descriptor: NodeDescriptor = {
    schemaVersion,
    nodeId: bytesToString(raw.nodeId) ?? "",
    nodeName: bytesToString(raw.nodeName) ?? "",
  };
  const publicHost = bytesToString(raw.publicHost);
  if (publicHost !== undefined) descriptor.publicHost = publicHost;
  const publicPort = finiteNumberOrUndef(raw.publicPort);
  if (publicPort !== undefined) descriptor.publicPort = publicPort;
  const rpcEndpoints = (Array.isArray(raw.rpcEndpoints) ? raw.rpcEndpoints : [])
    .map(bytesToString)
    .filter((s): s is string => s !== undefined);
  if (rpcEndpoints.length > 0) descriptor.rpcEndpoints = rpcEndpoints;
  if (typeof raw.autoMine === "boolean") descriptor.autoMine = raw.autoMine;
  const logLevel = mapLogLevel(raw.logLevel);
  if (logLevel !== undefined) descriptor.logLevel = logLevel;
  if (miners.length > 0) descriptor.miners = miners;
  const runtime = mapRuntime(raw.runtime);
  if (runtime !== undefined) descriptor.runtime = runtime;
  const systemInfo = mapSystemInfo(raw.systemInfo);
  if (systemInfo !== undefined) descriptor.systemInfo = systemInfo;
  if (raw.deposit !== undefined && raw.deposit !== null) {
    descriptor.deposit = String(raw.deposit);
  }

  return {
    accountId,
    updatedAtBlock: String(raw.updatedAt ?? "0"),
    payloadHash: typeof raw.payloadHash === "string" ? raw.payloadHash : "",
    descriptor,
  };
}

// Decode a polkadot.js codec for a v0.2 `DifficultyConfig` struct into the
// dashboard's normalised `DifficultyInfo` shape. Tolerates camelCase
// (toJSON) and snake_case (toHuman) field surfacing.
function decodeDifficulty(codec: unknown): DifficultyInfo {
  const json =
    typeof (codec as { toJSON?: () => unknown })?.toJSON === "function"
      ? ((codec as { toJSON: () => Record<string, unknown> }).toJSON() as Record<string, unknown>)
      : ((codec as Record<string, unknown>) ?? {});
  return {
    maxEnergyMilli: Number(json.maxEnergyMilli ?? json.max_energy_milli ?? 0),
    minDiversityMilli: Number(json.minDiversityMilli ?? json.min_diversity_milli ?? 0),
    minSolutions: Number(json.minSolutions ?? json.min_solutions ?? 0),
  };
}
