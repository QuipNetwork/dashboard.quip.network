// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { selectTipBlock, useTelemetryStore } from "../../../store/telemetry-store";
import type { BlockRecord, ChainMinerRecord, MinerStats } from "../../../types/telemetry";
import {
  computeLeaderboard,
  type LeaderboardEntry,
} from "../../charts/leaderboard/use-leaderboard";

export interface CurrentRequirements {
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;
}

export interface MyNodeStats {
  selfAddress: string | null;
  chainMinerEntry: ChainMinerRecord | null;
  minerStats: MinerStats | null;
  lastWonBlock: BlockRecord | null;
  // Total blocks won by self (from chain_miners.proofsWon, u64 string-safe).
  blocksMined: string;
  currentRequirements: CurrentRequirements | null;
  // Operator's own row in the network-wide (unfiltered) leaderboard. Null
  // until selfAddress is known *and* the operator has won at least one block
  // the indexer has captured.
  self: LeaderboardEntry | null;
  // Rank-adjacent miners (±NEIGHBOR_WINDOW around `self.rank`, self
  // excluded). Empty when `self` is null.
  neighbors: LeaderboardEntry[];
}

// How many ranks above and below self to surface in the rank-neighbor table.
// 2 above + 2 below + self = 5-row window, which fits the typical sidebar
// width without scrolling on desktop.
const NEIGHBOR_WINDOW = 2;

export function useMyNode(): MyNodeStats {
  const selfAddress = useTelemetryStore((s) => s.selfAddress);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const blocks = useTelemetryStore((s) => s.blocks);
  const indexer = useTelemetryStore((s) => s.indexer);
  const tipBlock = useTelemetryStore(selectTipBlock);
  // Most recent `current_difficulty()` poll. With quip-protocol-rs v0.2 this
  // is the runtime API call that returns the decayed live threshold the
  // pallet currently checks proofs against — fresher than tipBlock's
  // per-block snapshot, which can be the threshold from a winning proof
  // many hours ago. Survives wipe-on-drift restarts where `blocks` starts
  // empty but the indexer's first difficulty poll fires within 300s.
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);

  return useMemo<MyNodeStats>(() => {
    const chainMinerEntry = selfAddress
      ? (chainMiners.find((m) => m.accountId === selfAddress) ?? null)
      : null;
    const lastWonBlock = selfAddress
      ? (blocks.find((b) => b.minerId === selfAddress) ?? null)
      : null;
    // Chain-authoritative `proofs_won` for this account. Previously the
    // dashboard returned `max(localWinCount, chainProofsWon)` to absorb
    // poll-lag between the live substrate sub and chain_miners poll —
    // but local rows survive chain rebuilds via INSERT OR IGNORE on
    // substrate_block_number, so a stale local DB (e.g. across a
    // `make localdev` teardown that didn't wipe `./data/telemetry.*.db`)
    // would overstate wins by the count of prior-chain entries. Chain's
    // `proofs_won` is updated synchronously in `on_finalize`, so the
    // poll-lag window is bounded by the indexer's chain_miners poll
    // cadence (default 6s) — small enough to prefer correctness over
    // freshness. Follow-up: indexer should detect genesis-hash change
    // and wipe stale tables.
    const chainWins = Number(chainMinerEntry?.proofsWon ?? "0");
    const blocksMined = String(chainWins);
    const liveDifficulty = recentDifficulty[0] ?? null;
    const currentRequirements: CurrentRequirements | null = liveDifficulty
      ? {
          difficultyEnergy: liveDifficulty.difficultyEnergy,
          minDiversity: liveDifficulty.minDiversity,
          minSolutions: liveDifficulty.minSolutions,
        }
      : tipBlock
        ? {
            difficultyEnergy: tipBlock.difficultyEnergy,
            minDiversity: tipBlock.minDiversity,
            minSolutions: tipBlock.minSolutions,
          }
        : null;
    // Network-wide unfiltered leaderboard for rank-neighbor lookup. We
    // deliberately ignore the UI store's `selectedTypes` filter here —
    // the operator's rank in the network is not category-scoped.
    const leaderboard = computeLeaderboard(blocks, chainMiners, undefined, nodeDescriptors);
    const self = selfAddress ? (leaderboard.find((e) => e.minerId === selfAddress) ?? null) : null;
    const neighbors =
      self != null
        ? leaderboard.filter(
            (e) =>
              e.rank >= self.rank - NEIGHBOR_WINDOW &&
              e.rank <= self.rank + NEIGHBOR_WINDOW &&
              e.minerId !== self.minerId,
          )
        : [];
    return {
      selfAddress,
      chainMinerEntry,
      minerStats: indexer?.minerStats ?? null,
      lastWonBlock,
      blocksMined,
      currentRequirements,
      self,
      neighbors,
    };
  }, [selfAddress, chainMiners, nodeDescriptors, blocks, indexer, tipBlock, recentDifficulty]);
}
