// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ports the worker depends on. The chain client is segregated into role
// interfaces (ISP) so each collaborator declares only the slice it uses;
// `ChainClient` is their intersection, satisfied structurally by the real and
// fake clients.

import type { Observable } from "rxjs";

import type {
  BabeAuthorityInfo,
  BabeEpochInfo,
  BlockEvents,
  ChainMinerInfo,
  DifficultyInfo,
  MineableTopologyInfo,
  MinerRegistryDescriptorRecord,
  RuntimeVersionInfo,
  SubstrateHead,
  SyncStateInfo,
  TopologyInfo,
  UnsubFn,
  QBlockInfo,
  QBlockParticipant,
  WinnerBlockDecode,
} from "../clients/substrate-client";

export interface ConnectionControl {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onDisconnected(cb: () => void): UnsubFn;
}

export interface HeadSource {
  subscribeNewHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn>;
  subscribeFinalizedHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn>;
  getRuntimeVersion(): Promise<RuntimeVersionInfo>;
  getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null>;
  getQBlockCount(): Promise<number | null>;
  getQBlockParticipantCount(qblockId: string): Promise<number | null>;
  // Current finalized head number via RPC — the reconciler's per-tick head
  // source (never the persisted observability value, which is stale after
  // downtime; spec §5).
  getFinalizedHead(): Promise<string>;
}

export interface BlockSource {
  subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn>;
  getTopology(): Promise<TopologyInfo | null>;
  getDifficulty(): Promise<DifficultyInfo | null>;
  getLastProofBlockAt(blockHash: string): Promise<number>;
  getQBlock(blockNumber: string): Promise<QBlockInfo | null>;
  // Historical default topology for backfill items' topology stamping
  // (tip items resolve live via state.defaultTopologyHash; spec §6).
  getDefaultTopologyAt(blockNumber: string): Promise<string | null>;
  // Full participant set for a qblock — the participation plugin's only chain
  // read (keyed by the winner event's qblock id).
  getQBlockParticipants(qblockId: string): Promise<QBlockParticipant[]>;
}

export interface BackfillSource {
  getQBlockNumbers(): Promise<string[]>;
  processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null>;
  // Targeted winner-block decode: events + the single winning_solution fetch,
  // skipping derive.chain.getBlock. Used by the dispatcher for winner-only
  // backfill items (spec §Phase-1). Returns null for a non-winner block.
  decodeWinnerBlock(blockNumber: string): Promise<WinnerBlockDecode | null>;
}

export interface PollSource {
  getBabeEpoch(): Promise<BabeEpochInfo | null>;
  getBabeAuthorities(): Promise<BabeAuthorityInfo[]>;
  getChainMiners(): Promise<ChainMinerInfo[]>;
  getDifficulty(): Promise<DifficultyInfo | null>;
  getMineableTopologies(): Promise<MineableTopologyInfo[]>;
}

// Node sync status for the SyncGate (design 2026-07-04).
export interface SyncSource {
  getSyncState(): Promise<SyncStateInfo>;
}

// Finalized-state registry snapshots (the node-descriptors plugin's only
// chain call — same slice `descriptor/iteration.ts` declares locally).
export interface DescriptorSource {
  getMinerRegistryDescriptorsAt(
    blockNumber: string,
  ): Promise<MinerRegistryDescriptorRecord[] | null>;
}

// Distinct name from `sources.ChainSource` (the full SubstrateClient alias) so
// the two don't collide.
export type ChainClient = ConnectionControl &
  HeadSource &
  BlockSource &
  BackfillSource &
  PollSource &
  DescriptorSource &
  SyncSource;

// A per-connection side-effect stream the worker merges without knowing which
// is which (OCP — a new stream is one array entry, no edit to the worker).
export interface ConnectionStream {
  stream(): Observable<never>;
}
