// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import {
  computeLeaderboard,
  type LeaderboardEntry,
} from "../../charts/leaderboard/use-leaderboard";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import type { NodeInfo } from "../../../types/telemetry";

export interface MyNodeStats {
  // null when we can't identify "us" yet (indexer hasn't synced, or the
  // configured QUIP_NODE_URL doesn't appear in its own peer list).
  node: NodeInfo | null;
  selfAddress: string | null;
  blocksMined: number;
  uptimeMs: number | null;
  rank: number | null;
  totalMiners: number;
  entry: LeaderboardEntry | null;
  // Ranks rank-1 .. rank+2 in the unfiltered network leaderboard, excluding self.
  neighbors: LeaderboardEntry[];
}

const NEIGHBOR_WINDOW = 2;

export function useMyNode(): MyNodeStats {
  const blocks = useFilteredBlocks();
  const nodes = useTelemetryStore((s) => s.nodes);
  const selfAddress = useTelemetryStore((s) => s.selfAddress);

  return useMemo<MyNodeStats>(() => {
    const node = selfAddress ? (nodes?.nodes[selfAddress] ?? null) : null;

    // Canonical (unfiltered) ranking — "my rank" must not flip when the user
    // toggles type filters on the Network view.
    const leaderboard = computeLeaderboard(blocks);

    // A node may run several miner processes (one GPU + one CPU, say).
    // Match any leaderboard row whose minerId belongs to this node, using
    // three complementary rules — the upstream uses inconsistent shapes:
    //   1. block.minerId === node.nodeName            (most common)
    //   2. block.minerId === miner.minerId            (exact, rare)
    //   3. miner.minerId.startsWith(block.minerId)    (backend-suffixed:
    //      e.g. miner.minerId="qpu1.quip-QPU-DWAVE-1" for block.minerId="qpu1.quip")
    const minerIdMatchers: string[] = [];
    if (node?.nodeName) minerIdMatchers.push(node.nodeName);
    for (const miner of Object.values(node?.miners ?? {})) {
      if (miner.minerId) minerIdMatchers.push(miner.minerId);
    }
    const isMine = (minerId: string): boolean => {
      for (const m of minerIdMatchers) {
        if (m === minerId) return true;
        if (m.startsWith(minerId + "-")) return true;
      }
      return false;
    };
    const myRows = leaderboard.filter((e) => isMine(e.minerId));
    const blocksMined = myRows.reduce((sum, r) => sum + r.blockCount, 0);

    // Prefer the "primary" miner entry: the highest-ranking one that's
    // actually present in the snapshot. If the node has no miners in the
    // snapshot yet, there's no rank to show.
    const entry = myRows[0] ?? null;
    const rank = entry?.rank ?? null;

    const neighbors =
      entry != null
        ? leaderboard.filter(
            (e) =>
              e.rank >= entry.rank - NEIGHBOR_WINDOW &&
              e.rank <= entry.rank + NEIGHBOR_WINDOW &&
              !isMine(e.minerId),
          )
        : [];

    const uptimeMs = node ? Date.now() - node.firstSeen * 1000 : null;

    return {
      node,
      selfAddress,
      blocksMined,
      uptimeMs,
      rank,
      totalMiners: leaderboard.length,
      entry,
      neighbors,
    };
  }, [blocks, nodes, selfAddress]);
}
