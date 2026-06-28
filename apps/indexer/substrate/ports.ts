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
  RuntimeVersionInfo,
  SubstrateHead,
  TopologyInfo,
  UnsubFn,
  WinningSolutionInfo,
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
  getWinningSolutionsCount(): Promise<number | null>;
  getQBlockParticipantCount(qblockId: string): Promise<number | null>;
}

export interface BlockSource {
  subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn>;
  getTopology(): Promise<TopologyInfo | null>;
  getDifficulty(): Promise<DifficultyInfo | null>;
  getLastProofBlockAt(blockHash: string): Promise<number>;
  getWinningSolution(blockNumber: string): Promise<WinningSolutionInfo | null>;
}

export interface BackfillSource {
  getWinningBlockNumbers(): Promise<string[]>;
  processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null>;
}

export interface PollSource {
  getBabeEpoch(): Promise<BabeEpochInfo | null>;
  getBabeAuthorities(): Promise<BabeAuthorityInfo[]>;
  getChainMiners(): Promise<ChainMinerInfo[]>;
  getDifficulty(): Promise<DifficultyInfo | null>;
  getMineableTopologies(): Promise<MineableTopologyInfo[]>;
}

// Distinct name from `sources.ChainSource` (the full SubstrateClient alias) so
// the two don't collide.
export type ChainClient = ConnectionControl &
  HeadSource &
  BlockSource &
  BackfillSource &
  PollSource;

// A per-connection side-effect stream the worker merges without knowing which
// is which (OCP — a new stream is one array entry, no edit to the worker).
export interface ConnectionStream {
  stream(): Observable<never>;
}
