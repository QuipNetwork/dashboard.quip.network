// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityInfo,
  BabeEpochInfo,
  BlockEvents,
  BlockWinnerEvent,
  ChainMinerInfo,
  DifficultyInfo,
  MineableTopologyInfo,
  MinerRegistryDescriptorRecord,
  RuntimeVersionInfo,
  SubstrateClient,
  SubstrateHead,
  SyncStateInfo,
  TopologyInfo,
  UnsubFn,
  QBlockInfo,
  QBlockParticipant,
  WinnerBlockDecode,
} from "./types";

import { StatePrunedError } from "./errors";

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
  // Historical DefaultTopology by block-number string — tests populate the
  // heights they exercise; absent keys read as null.
  public defaultTopologyByBlock = new Map<string, string>();
  // Keyed by blockNumber string. Tests populate this for the block(s) they
  // emit via `emitBlock`; the worker reads it back through
  // `getQBlock(blockNumber)` to source per-block difficulty and
  // nonce in BlockRecord construction.
  public qblocksByBlock = new Map<string, QBlockInfo>();
  public runtimeVersion: RuntimeVersionInfo = {
    specName: "quip",
    specVersion: 101,
    transactionVersion: 2,
    implName: "quip",
  };
  public lastRuntimeUpgrade: { blockNumber: string } | null = null;

  // Test knobs for reconnect behaviour: `connectCount` counts every connect
  // ATTEMPT (incremented before any hang), and `hangNextConnect` makes the
  // next connect() never resolve — simulating a half-open socket whose
  // connect neither succeeds nor rejects.
  public connectCount = 0;
  public hangNextConnect = false;
  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.hangNextConnect) {
      this.hangNextConnect = false;
      await new Promise<void>(() => {});
    }
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
  // Sync-gate knobs: tests mutate `syncState` to simulate a node entering /
  // leaving major sync; set `syncStateError` to make getSyncState throw
  // (simulating an RPC failure).
  public syncState: SyncStateInfo = {
    isSyncing: false,
    peers: 1,
    currentBlock: null,
    highestBlock: null,
  };
  public syncStateError: Error | null = null;
  async getSyncState(): Promise<SyncStateInfo> {
    if (this.syncStateError) throw this.syncStateError;
    return this.syncState;
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
  // Tests set this directly (or it tracks the highest emitted finalized head).
  public finalizedHead = "0";
  async getFinalizedHead(): Promise<string> {
    return this.finalizedHead;
  }
  async getTopology(): Promise<TopologyInfo | null> {
    return this.topology;
  }
  async getDefaultTopologyAt(blockNumber: string): Promise<string | null> {
    this.throwIfPruned(blockNumber);
    return this.defaultTopologyByBlock.get(blockNumber) ?? null;
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
  // Keyed by qblock id string; tests populate the participant set they expect
  // the participation plugin to read. Absent keys read as an empty set.
  public qblockParticipants = new Map<string, QBlockParticipant[]>();
  async getQBlockParticipants(qblockId: string): Promise<QBlockParticipant[]> {
    return this.qblockParticipants.get(qblockId) ?? [];
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
  async getQBlock(blockNumber: string): Promise<QBlockInfo | null> {
    return this.qblocksByBlock.get(blockNumber) ?? null;
  }
  async getQBlockNumbers(): Promise<string[]> {
    return [...this.qblocksByBlock.keys()];
  }
  async getQBlockCount(): Promise<number | null> {
    return this.qblocksByBlock.size;
  }
  // Tests populate `historicalBlocks` (keyed by blockNumber string) for any
  // historical winning block the backfill loop should be able to fetch.
  public historicalBlocks = new Map<string, BlockEvents>();
  // R5 knob (spec §8): tier-2 reads below this height throw StatePrunedError,
  // simulating a shallow-pruning node. Null = archive (default).
  public prunedBelowBlock: number | null = null;
  pruneBelow(n: number | null): void {
    this.prunedBelowBlock = n;
  }
  private throwIfPruned(blockNumber: string): void {
    if (this.prunedBelowBlock !== null && Number(blockNumber) < this.prunedBelowBlock) {
      throw new StatePrunedError(`state already discarded for block ${blockNumber}`);
    }
  }
  async processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null> {
    this.throwIfPruned(blockNumber);
    return this.historicalBlocks.get(blockNumber) ?? null;
  }
  // Targeted winner decode: same source as processFinalizedBlock but returns
  // the block's events (author nulled, matching production's winner path) plus
  // the single programmed QBlock. Null for a non-winner block.
  async decodeWinnerBlock(blockNumber: string): Promise<WinnerBlockDecode | null> {
    this.throwIfPruned(blockNumber);
    const source = this.historicalBlocks.get(blockNumber) ?? null;
    if (!source || source.winner === null) return null;
    const qblock = this.qblocksByBlock.get(blockNumber) ?? null;
    return {
      events: { ...source, author: null, nonce: qblock?.nonce ?? null },
      qblock,
    };
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
