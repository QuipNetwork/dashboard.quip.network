// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import type {
  BlockRecord,
  ChainMinerRecord,
  MinerWinsRow,
  MiningSubmissionRecord,
  NodeDescriptorRecord,
} from "@quip/shared/telemetry";
import {
  computeLeaderboard,
  type LeaderboardEntry,
} from "@/components/charts/leaderboard/use-leaderboard";
import { qblockNumber, type CurrentRequirements } from "@/components/views/MyNode/use-my-node";
import { selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";

/**
 * Chain/indexer-derived stats for ANY account — the peer analogue of
 * {@link useMyNode}, minus the self-only live counters (those come from the
 * on-demand peer proxy via {@link useNodeLiveData}). Every field here is
 * available network-wide from the telemetry store, so the Node page renders
 * these sections for any node regardless of reachability.
 */
export interface NodeStats {
  accountId: string;
  chainMinerEntry: ChainMinerRecord | null;
  descriptor: NodeDescriptorRecord | null;
  lastWonBlock: BlockRecord | null;
  lastWonProblemNumber: number | null;
  // Chain-authoritative lifetime wins (proofsWon, u64 string-safe) — the
  // same counter the leaderboard ranks by.
  blocksMined: string;
  avgMiningTimeSec: number | null;
  currentRequirements: CurrentRequirements | null;
  // Chain-derived synthetic rows for this node's wins (we hold no local
  // mining_submissions for peers — those are self-only).
  recentSubmissions: MiningSubmissionRecord[];
  self: LeaderboardEntry | null;
  neighbors: LeaderboardEntry[];
}

// Mirror useMyNode's rank-neighbor window (2 above + 2 below + self).
const NEIGHBOR_WINDOW = 2;

/**
 * `minerWins` is the shared `/api/miner-wins` dataset (from `useMinerWins()`
 * at the view level — injected, like {@link useMyNode}, so the hook stays a
 * pure store-derived computation).
 */
export function useNode(accountId: string, minerWins: readonly MinerWinsRow[] = []): NodeStats {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const blocks = useTelemetryStore((s) => s.blocks);
  const tipBlock = useTelemetryStore(selectTipBlock);
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);

  return useMemo<NodeStats>(() => {
    const chainMinerEntry = chainMiners.find((m) => m.accountId === accountId) ?? null;
    const descriptor = nodeDescriptors.find((d) => d.accountId === accountId) ?? null;
    const nodeBlocks = blocks.filter((b) => b.minerId === accountId);
    const lastWonBlock = nodeBlocks[0] ?? null;

    // Global qblock/solution number = the chain-authoritative qblockId, so the
    // "Sol #" numbering matches local mining_submissions and the rest of the
    // dashboard (not a window-relative position).
    const lastWonProblemNumber = lastWonBlock != null ? qblockNumber(lastWonBlock) : null;

    const avgMiningTimeSec =
      nodeBlocks.length > 0
        ? nodeBlocks.reduce((sum, b) => sum + b.miningTime, 0) / nodeBlocks.length
        : null;

    const blocksMined = chainMinerEntry?.proofsWon ?? "0";

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

    // Chain-only synthetic submission rows for this node's wins — the only
    // performance feed available for a peer.
    const minerType = chainMinerEntry?.hardware?.primaryType ?? "";
    const recentSubmissions: MiningSubmissionRecord[] = nodeBlocks.map((b) => ({
      solutionNumber: qblockNumber(b) ?? 0,
      minerId: b.minerId,
      minerType,
      tsNs: String(BigInt(b.timestamp) * 1_000_000_000n),
      energyMilli: Math.round(b.energy * 1000),
      diversityMilli: Math.round(b.diversity * 1000),
      thresholdMilli: Math.round(b.difficultyEnergy * 1000),
      lastProofBlockHash: "",
      extrinsicHash: null,
      chainBlockHash: b.blockHash,
      chainBlockNumber: b.substrateBlockNumber,
      powSequence: null,
      outcome: "submitted_inblock",
      attemptCount: 0,
      bestEnergyMilli: Math.round(b.energy * 1000),
      numValid: b.numValidSolutions,
      qpuAccessTimeUs: 0,
      observedAt: new Date(b.timestamp * 1000).toISOString(),
      chainOnly: true,
    }));

    const leaderboard = computeLeaderboard(chainMiners, minerWins, undefined, nodeDescriptors);
    const self = leaderboard.find((e) => e.minerId === accountId) ?? null;
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
      accountId,
      chainMinerEntry,
      descriptor,
      lastWonBlock,
      lastWonProblemNumber,
      blocksMined,
      avgMiningTimeSec,
      currentRequirements,
      recentSubmissions,
      self,
      neighbors,
    };
  }, [accountId, chainMiners, nodeDescriptors, blocks, minerWins, tipBlock, recentDifficulty]);
}
