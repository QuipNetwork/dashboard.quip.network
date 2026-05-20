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
// quip-protocol-rs/pallets/quantum-pow/src/lib.rs:159-164). The substrate
// worker subscribes to system.events and filters for these.
export interface BlockWinnerEvent {
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
  qualityMilli: number;
}

// Aggregated per-finalized-block payload emitted by subscribeBlockEvents.
// Pairs the winning BlockWinner event with every ProofAccepted event in
// the same block, plus the nonce pulled from the winner's submit_proof
// extrinsic. Timestamp is unix seconds (converted from substrate's
// millisecond timestamp.now).
export interface BlockEvents {
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number; // unix seconds
  winner: BlockWinnerEvent;
  proofs: ProofAcceptedEvent[];
  nonce: string; // u64 from the winning submit_proof extrinsic's proof.nonce
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

// Difficulty snapshot from pallet-quantum-pow's Difficulty storage. This
// is the WIRE shape — fields mirror the on-chain `DifficultyConfig` struct
// in quip-protocol-rs/pallets/quantum-pow/src/types.rs:38-43. The substrate
// worker converts to DifficultyRecord (milli → float) before DB write.
export interface DifficultyInfo {
  maxEnergyMilli: number;
  minDiversityMilli: number;
  minSolutions: number;
  minQualityMilli: number;
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
  getRuntimeVersion(): Promise<RuntimeVersionInfo>;
  getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null>;

  // Used by the worker after a BlockWinner event fires: look up the
  // substrate header at `submitted_at` to fill substrate_block_hash /
  // parent / roots.
  getBlockHeader(blockNumber: string): Promise<SubstrateHead | null>;
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
  public runtimeVersion: RuntimeVersionInfo = {
    specName: "quip",
    specVersion: 101,
    transactionVersion: 2,
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
  async getRuntimeVersion(): Promise<RuntimeVersionInfo> {
    return this.runtimeVersion;
  }
  async getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null> {
    return this.lastRuntimeUpgrade;
  }
  async getBlockHeader(blockNumber: string): Promise<SubstrateHead | null> {
    return this.headers.get(blockNumber) ?? null;
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

/**
 * @polkadot/api-backed implementation. Pinned to 15.9.1 in package.json so
 * @polkadot/types stays in lockstep (a mismatch produces opaque decode
 * errors). Storage queries assume quip-protocol-rs spec_version 101 —
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
      // Should never happen on Substrate, but capability-checked for safety.
      return () => {};
    }
    // Subscribes to ALL events; filter to quantumPow.BlockWinner. Event
    // shape: (miner: AccountId, reward: Balance, energy_milli: i64,
    // submitted_at: BlockNumber). Verified against
    // quip-protocol-rs/pallets/quantum-pow/src/lib.rs:159-164.
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
        const [minerCodec, rewardCodec, energyCodec, submittedAtCodec] = event.data;
        if (!minerCodec || !rewardCodec || !energyCodec || !submittedAtCodec) continue;
        cb({
          miner: minerCodec.toString(),
          reward: rewardCodec.toString(),
          energyMilli: Number(energyCodec.toString()),
          submittedAt: submittedAtCodec.toString(),
        });
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
    // authorityCount = session.validators().length (session rotates per BABE epoch).
    let authorityCount = 0;
    if (api.query.session?.validators) {
      const validators = await api.query.session.validators();
      authorityCount = Array.isArray(validators)
        ? validators.length
        : ((validators as unknown as { length?: number }).length ?? 0);
    }
    return { epochIndex, currentSlot, epochStartSlot, slotsPerEpoch, authorityCount };
  }

  async getBabeAuthorities(): Promise<BabeAuthorityInfo[]> {
    const api = this.requireApi();
    if (!api.query.session?.validators) return [];
    const codec = await api.query.session.validators();
    const list = codec as unknown as Array<{ toString: () => string }>;
    // Identity pallet not enabled on quip-protocol-rs spec 101 — displayName
    // stays null. When it ships, layer in a per-account identityOf() lookup.
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
    if (!api.query.quantumPow?.difficulty) return null;
    const codec = await api.query.quantumPow.difficulty();
    // DifficultyConfig from pallet-quantum-pow/src/types.rs:38-43.
    const json = (codec as unknown as { toJSON: () => Record<string, unknown> }).toJSON();
    return {
      maxEnergyMilli: Number(json.maxEnergyMilli ?? json.max_energy_milli ?? 0),
      minDiversityMilli: Number(json.minDiversityMilli ?? json.min_diversity_milli ?? 0),
      minSolutions: Number(json.minSolutions ?? json.min_solutions ?? 0),
      minQualityMilli: Number(json.minQualityMilli ?? json.min_quality_milli ?? 0),
    };
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

  async subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    // system.events and timestamp.now are present on every Substrate
    // runtime; capture local refs once so the inner Promise.all stays
    // narrowed under TS strict optional chaining.
    const eventsAt = api.query.system?.events?.at;
    const timestampAt = api.query.timestamp?.now?.at;
    if (!eventsAt || !timestampAt) {
      throw new Error("[substrate-client] runtime missing system.events or timestamp.now");
    }
    // Finalized-only subscription. Trades ~6-12s latency for canonical
    // ordering: a reorged-out block will never be observed, so the worker
    // never writes a row it later has to roll back. New-head streams give
    // the opposite tradeoff and are not appropriate for the canonical
    // block writer path.
    const unsubFn = await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      const blockNumber = header.number.toNumber();
      const blockHash = header.hash.toHex();
      const parentHash = header.parentHash.toHex();
      const [signedBlock, eventsAtBlock, timestampAtBlock] = await Promise.all([
        api.rpc.chain.getBlock(header.hash),
        eventsAt(header.hash),
        timestampAt(header.hash),
      ]);

      type EventRecord = {
        event: {
          section: string;
          method: string;
          data: Array<{ toString: () => string }>;
        };
      };
      let winner: BlockWinnerEvent | null = null;
      const proofs: ProofAcceptedEvent[] = [];
      for (const rec of eventsAtBlock as unknown as EventRecord[]) {
        const { section, method, data } = rec.event;
        if (section !== "quantumPow") continue;
        if (method === "BlockWinner") {
          const [minerCodec, rewardCodec, energyCodec, submittedAtCodec] = data;
          if (!minerCodec || !rewardCodec || !energyCodec || !submittedAtCodec) continue;
          winner = {
            miner: minerCodec.toString(),
            reward: rewardCodec.toString(),
            energyMilli: Number(energyCodec.toString()),
            submittedAt: submittedAtCodec.toString(),
          };
        } else if (method === "ProofAccepted") {
          const [minerCodec, energyCodec, diversityCodec, validCodec, qualityCodec] = data;
          if (!minerCodec || !energyCodec || !diversityCodec || !validCodec || !qualityCodec) {
            continue;
          }
          proofs.push({
            miner: minerCodec.toString(),
            energyMilli: Number(energyCodec.toString()),
            diversityMilli: Number(diversityCodec.toString()),
            validSolutionCount: Number(validCodec.toString()),
            qualityMilli: Number(qualityCodec.toString()),
          });
        }
      }
      // No BlockWinner means the block contained no winning proof; the
      // canonical writer path has nothing to record for this block.
      if (!winner) return;
      const nonce = extractNonce(signedBlock, winner);
      cb({
        blockNumber,
        blockHash,
        parentHash,
        // pallet_timestamp returns milliseconds; the indexer stores unix
        // seconds (BlockRecord.timestamp) for parity with the legacy REST
        // path. Truncate rather than round to keep ordering stable.
        timestamp: Math.floor(
          Number((timestampAtBlock as unknown as { toString: () => string }).toString()) / 1000,
        ),
        winner,
        proofs,
        nonce,
      });
    });
    return () => {
      (unsubFn as unknown as () => void)();
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
 * Pull the nonce out of the winning `quantumPow.submit_proof` extrinsic.
 *
 * Identification follows the pallet contract: `submit_proof` is `ensure_signed`
 * (quip-protocol-rs/pallets/quantum-pow/src/lib.rs:346) and the miner is
 * the extrinsic's signer — the `QuantumProof` struct itself carries no
 * miner field (types.rs:8-23). We match `ext.signer.toString() === winner.miner`
 * and pull `proof.nonce` (u64) from `ext.method.args[0]`.
 *
 * Returns "0" if no matching extrinsic is found, which lets the substrate
 * worker still record the block instead of dropping it on a transient
 * decode anomaly.
 */
function extractNonce(signedBlock: unknown, winner: BlockWinnerEvent): string {
  type SignedExtrinsic = {
    isSigned: boolean;
    signer: { toString: () => string };
    method: { section: string; method: string; args: Array<{ toString: () => string }> };
  };
  const block = (signedBlock as { block: { extrinsics: SignedExtrinsic[] } }).block;
  for (const ext of block.extrinsics) {
    if (!ext.isSigned) continue;
    // Polkadot.js exposes call names as defined in the runtime metadata.
    // pallet-quantum-pow declares the call as `submit_proof`; the metadata
    // dispatcher exposes it under the same name.
    if (ext.method.section !== "quantumPow" || ext.method.method !== "submit_proof") continue;
    if (ext.signer.toString() !== winner.miner) continue;
    const proof = ext.method.args[0] as unknown as { nonce?: { toString: () => string } };
    return proof?.nonce?.toString() ?? "0";
  }
  return "0";
}
