// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-time topology-tag backfill. Migration 0004 adds `blocks.topology_hash`
// nullable but cannot stamp the chain's hash, and the live indexer only tags
// NEW blocks. A block's topology is NOT carried on its qblock — under model A
// (single active topology) it is the chain's `DefaultTopology` at that block's
// height, which the node still serves from historical state.
//
// This pass walks legacy NULL-tagged blocks newest-first and, while
// `DefaultTopology` at each equals the current default, stamps them — so the
// API's strict topology filter shows the current-topology history again. It
// STOPS at the first block on a prior topology (the last topology change):
// everything older belongs to a previous topology and stays NULL (correctly out
// of scope). Difficulty rows from the boundary block onward are adopted into the
// current topology. Bounded by `maxBlocks` (only the recent window is shown).

import type { MineableTopologyInfo } from "../clients/substrate-client";

// Chain reads the backfill needs (ISP — a slice of SubstrateClient).
export interface TopologyBackfillSource {
  getMineableTopologies(): Promise<MineableTopologyInfo[]>;
  getDefaultTopologyAt(blockNumber: string): Promise<string | null>;
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
  tagged: number; // blocks stamped with the current default topology
  difficultyTagged: number; // difficulty rows adopted into the current topology
  reachedBoundary: boolean; // hit a prior-topology block (the last change)
  capped: boolean; // more current-topology NULL blocks remained than maxBlocks
}

const DEFAULT_MAX_BLOCKS = 2000;

const EMPTY: TopologyBackfillSummary = {
  scanned: 0,
  tagged: 0,
  difficultyTagged: 0,
  reachedBoundary: false,
  capped: false,
};

export async function backfillTopologyTags(deps: {
  source: TopologyBackfillSource;
  store: TopologyBackfillStore;
  maxBlocks?: number;
}): Promise<TopologyBackfillSummary> {
  const { source, store } = deps;
  const maxBlocks = deps.maxBlocks ?? DEFAULT_MAX_BLOCKS;

  // Current default hash, sourced the same way the API filter is.
  const defaultHash = (await source.getMineableTopologies()).find((t) => t.isDefault)?.topologyHash;
  if (!defaultHash) return EMPTY; // no default topology → nothing to scope to

  const batch = await store.getBlocksMissingTopology(maxBlocks);

  // Walk newest-first; tag while on the current default, stop at the boundary
  // (the most recent topology change). Under model A everything above the
  // boundary is the current topology, so this tags exactly the current run.
  let tagged = 0;
  let reachedBoundary = false;
  let minCurrentBlock: bigint | null = null;
  let scanned = 0;
  for (const b of batch) {
    scanned += 1;
    let topo: string | null;
    try {
      topo = await source.getDefaultTopologyAt(b.substrateBlockNumber);
    } catch {
      break; // can't read historical state: stop here, a later run retries
    }
    if (topo !== defaultHash) {
      reachedBoundary = true; // prior topology → the last change; older stays NULL
      break;
    }
    await store.setBlockTopology(b.blockHash, defaultHash);
    tagged += 1;
    const n = BigInt(b.substrateBlockNumber);
    if (minCurrentBlock === null || n < minCurrentBlock) minCurrentBlock = n;
  }

  let difficultyTagged = 0;
  if (minCurrentBlock !== null) {
    difficultyTagged = await store.backfillDifficultyTopology(
      minCurrentBlock.toString(),
      defaultHash,
    );
  }

  // Capped only when we tagged the whole window without reaching the boundary.
  const capped = !reachedBoundary && tagged >= maxBlocks;
  return { scanned, tagged, difficultyTagged, reachedBoundary, capped };
}
