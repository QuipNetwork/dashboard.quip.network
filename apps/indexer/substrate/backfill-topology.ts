// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-time topology-tag backfill. Migration 0004 adds `blocks.topology_hash`
// nullable but cannot stamp the chain's hash, and the live indexer only tags
// NEW blocks. This pass re-reads each legacy NULL block's qblock and stamps the
// topology it was actually won under, so the API's strict topology filter shows
// the current-topology history again (and correctly excludes prior-topology
// blocks instead of blanking every chart on deploy). Each block gets its TRUE
// topology, so no "last change" boundary detection is needed for blocks; the
// boundary is only derived for difficulty rows (which carry no per-row qblock).
//
// Bounded by `maxBlocks`: only the recent window is displayed, so backfilling
// every historical block is wasted work — the cap is logged when hit.

import type { MineableTopologyInfo, QBlockInfo } from "../clients/substrate-client";

// Chain reads the backfill needs (ISP — a slice of SubstrateClient).
export interface TopologyBackfillSource {
  getMineableTopologies(): Promise<MineableTopologyInfo[]>;
  getQBlock(blockNumber: string): Promise<QBlockInfo | null>;
}

// DB writes the backfill needs (a slice of DatabaseAdapter).
export interface TopologyBackfillStore {
  getBlocksMissingTopology(
    limit: number,
  ): Promise<Array<{ blockHash: string; substrateBlockNumber: string }>>;
  setBlockTopology(blockHash: string, topologyHash: string): Promise<void>;
  backfillDifficultyTopology(fromBlock: string, topologyHash: string): Promise<number>;
}

export interface TopologyBackfillSummary {
  scanned: number; // NULL blocks examined
  tagged: number; // blocks stamped with a topology
  currentTopologyBlocks: number; // of those, on the current default topology
  difficultyTagged: number; // difficulty rows adopted into the current topology
  capped: boolean; // more NULL blocks remained than maxBlocks
}

const DEFAULT_MAX_BLOCKS = 2000;

const EMPTY: TopologyBackfillSummary = {
  scanned: 0,
  tagged: 0,
  currentTopologyBlocks: 0,
  difficultyTagged: 0,
  capped: false,
};

export async function backfillTopologyTags(deps: {
  source: TopologyBackfillSource;
  store: TopologyBackfillStore;
  maxBlocks?: number;
}): Promise<TopologyBackfillSummary> {
  const { source, store } = deps;
  const maxBlocks = deps.maxBlocks ?? DEFAULT_MAX_BLOCKS;

  // The current default hash, sourced the same way the API filter is — so the
  // qblock topology (also toJSON-derived) compares byte-identically.
  const defaultHash = (await source.getMineableTopologies()).find((t) => t.isDefault)?.topologyHash;
  if (!defaultHash) return EMPTY; // no default topology → nothing to scope to

  const missing = await store.getBlocksMissingTopology(maxBlocks + 1);
  const capped = missing.length > maxBlocks;
  const batch = capped ? missing.slice(0, maxBlocks) : missing;

  let tagged = 0;
  let currentTopologyBlocks = 0;
  // Smallest current-topology block number seen — the start of the current
  // topology's run, used to scope the difficulty backfill.
  let minCurrentBlock: bigint | null = null;

  for (const b of batch) {
    let ws: QBlockInfo | null = null;
    try {
      ws = await source.getQBlock(b.substrateBlockNumber);
    } catch {
      continue; // transient read failure: leave NULL, a later run retries
    }
    const hash = ws?.topologyHash;
    if (!hash) continue; // unknown topology: leave NULL (stays out of scope)
    await store.setBlockTopology(b.blockHash, hash);
    tagged += 1;
    if (hash === defaultHash) {
      currentTopologyBlocks += 1;
      const n = BigInt(b.substrateBlockNumber);
      if (minCurrentBlock === null || n < minCurrentBlock) minCurrentBlock = n;
    }
  }

  let difficultyTagged = 0;
  if (minCurrentBlock !== null) {
    difficultyTagged = await store.backfillDifficultyTopology(
      minCurrentBlock.toString(),
      defaultHash,
    );
  }

  return { scanned: batch.length, tagged, currentTopologyBlocks, difficultyTagged, capped };
}
