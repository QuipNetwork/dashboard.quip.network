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
  miner: string;         // SS58 account ID
  reward: string;        // u128 as string
  energyMilli: number;   // integer; divide by 1000 to compare to BlockRecord.energy
  submittedAt: string;   // substrate block number (u64 as string)
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
  private headers = new Map<string, SubstrateHead>();

  public babeEpoch: BabeEpochInfo | null = null;
  public babeAuthorities: BabeAuthorityInfo[] = [];
  public chainMiners: ChainMinerInfo[] = [];
  public difficulty: DifficultyInfo | null = null;
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
  setHeader(h: SubstrateHead): void {
    this.headers.set(h.number, h);
  }
}
