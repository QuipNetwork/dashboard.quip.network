// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityInfo,
  BabeEpochInfo,
  BlockEvents,
  BlockWinnerEvent,
  ChainMinerInfo,
  DifficultyInfo,
  MinerRegistryDescriptorRecord,
  RuntimeVersionInfo,
  SubstrateClient,
  SubstrateHead,
  TopologyInfo,
  UnsubFn,
  WinningSolutionInfo,
} from "./types";

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
  // Tests populate `minerRegistryDescriptorsByBlock` (keyed by scan block)
  // with the storage snapshot the descriptor worker should observe.
  public minerRegistryDescriptorsByBlock = new Map<
    string,
    MinerRegistryDescriptorRecord[] | null
  >();
  async getMinerRegistryDescriptorsAt(
    blockNumber: string,
  ): Promise<MinerRegistryDescriptorRecord[] | null> {
    const v = this.minerRegistryDescriptorsByBlock.get(blockNumber);
    return v === undefined ? [] : v;
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
