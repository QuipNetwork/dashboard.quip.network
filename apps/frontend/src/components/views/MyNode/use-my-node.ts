// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";
import type {
  BlockRecord,
  ChainMinerRecord,
  MinerStats,
  MinerWinsRow,
  MiningSubmissionRecord,
  ModeBreakdown,
} from "@quip/shared/telemetry";
import {
  computeLeaderboard,
  type LeaderboardEntry,
} from "@/components/charts/leaderboard/use-leaderboard";

export interface CurrentRequirements {
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;
}

export interface MyNodeStats {
  selfAddress: string | null;
  chainMinerEntry: ChainMinerRecord | null;
  minerStats: MinerStats | null;
  // Per-backend breakdown — populated when the operator's container
  // runs the multi-process aggregator (one quip-miner per active
  // backend group). Empty / undefined for single-process miners,
  // in which case the UI omits the per-mode row.
  modes: Record<string, ModeBreakdown> | undefined;
  lastWonBlock: BlockRecord | null;
  // Chain-wide problem number that `lastWonBlock` represents — the
  // 1-based index of that block in the ASC-sorted chain history. Lets
  // the "Last Problem Won" tile show "Problem #36" instead of treating
  // the operator's win-count as the problem id. Null until at least
  // one self-win is in `blocks`; capped by `blocks.length` (server
  // returns the 500 most recent, so accuracy degrades past problem
  // #500 — fine for current chain depths).
  lastWonProblemNumber: number | null;
  // Total qblocks won by self — the chain-authoritative lifetime
  // `proofs_won` counter (u64 string-safe), the same number the leaderboard
  // and rank-neighbor rows rank by and the rewards line reflects.
  blocksMined: string;
  // Merged Recent Performance feed: local `mining_submissions` rows
  // (full fidelity — solutionNumber, attemptCount, outcome) plus
  // chain-derived synthetic rows for self-won blocks the local table
  // has no record of (typical after a miner reset wipes
  // mining_submissions). Sorted DESC by timestamp so the freshest row
  // is first.
  recentSubmissions: MiningSubmissionRecord[];
  // Chain-floored variant of indexer.minerStats. After a miner restart
  // the controller counters reset to 0; the chain remembers our 5
  // submissions. Using `max(local, chain)` for the relevant fields
  // means the headline tiles never undershoot the chain truth. Null
  // when no /api/v1/stats poll has landed yet (fresh deploy).
  effectiveMinerStats: MinerStats | null;
  // Chain-floored problemsAttempted. `selfProblemsAttempted` from the
  // server counts distinct `mining_submissions.solution_number` rows, a
  // recent window the indexer persists. We floor at chain proofsSubmitted
  // since every chain submission was, by definition, a problem
  // attempted.
  effectiveProblemsAttempted: number;
  // Average mining time (seconds) over self's recent chain-side wins.
  // Replaces miner-side `avg_mining_time`, which /api/v1/stats no longer
  // publishes. Null until at least one self-win is in `blocks`.
  selfAvgMiningTimeSec: number | null;
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

/**
 * The chain-authoritative global qblock number for a won block (from the
 * BlockWinner `qblock_id`). Null when the chain didn't stamp a positive id —
 * callers treat that as "unknown" (em-dash / suppressed modal).
 */
export function qblockNumber(block: { qblockId: string }): number | null {
  const n = Number(block.qblockId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `minerWins` is the shared `/api/miner-wins` dataset (from `useMinerWins()`
 * at the view level — injected rather than fetched here so the hook stays a
 * pure store-derived computation and tests don't need a network seam).
 */
export function useMyNode(minerWins: readonly MinerWinsRow[] = []): MyNodeStats {
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
  // Local-side fidelity feed: full mining_submissions rows persisted by
  // the indexer. Carries attemptCount + solutionNumber the chain doesn't
  // expose.
  const recentMiningSubmissions = useTelemetryStore((s) => s.recentMiningSubmissions);
  // Server-counted distinct solution_numbers in mining_submissions. Floor
  // we apply below with chain proofsSubmitted to never undershoot the
  // chain truth across miner restarts.
  const selfProblemsAttempted = useTelemetryStore((s) => s.selfProblemsAttempted);

  return useMemo<MyNodeStats>(() => {
    const chainMinerEntry = selfAddress
      ? (chainMiners.find((m) => m.accountId === selfAddress) ?? null)
      : null;
    const selfBlocks = selfAddress ? blocks.filter((b) => b.minerId === selfAddress) : [];
    const lastWonBlock = selfBlocks[0] ?? null;
    // The global qblock/solution number for a win is the chain-authoritative
    // `qblockId` (from the BlockWinner event) — the same counter the header's
    // "current problem" (`qblockCount + 1`) and local mining_submissions use.
    // (Previously derived as a position within the loaded window, which broke
    // once chain history exceeded the 500-row window — the "Sol #" column then
    // showed two incompatible numbering schemes.)
    const lastWonProblemNumber = lastWonBlock != null ? qblockNumber(lastWonBlock) : null;
    const selfAvgMiningTimeSec =
      selfBlocks.length > 0
        ? selfBlocks.reduce((sum, b) => sum + b.miningTime, 0) / selfBlocks.length
        : null;
    // Chain-authoritative lifetime wins — the same counter the leaderboard
    // ranks by, so the tile always matches the ranked tables and rewards.
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
    // --- Merged Recent Performance feed ---
    // The indexer only persists a recent window of miner-side
    // mining_submissions (it seeds its checkpoint near the current global
    // solution_number and the miner only keeps directories for solutions
    // it was online for), but the chain still remembers every winning
    // block. Without this synthesis the panel collapses to that recent
    // fragment and the operator can no longer scan their lifetime wins
    // from MyNode.
    //
    // Strategy: derive a synthetic MiningSubmissionRecord from each
    // self-won chain block that has no corresponding local row
    // (matched on chainBlockNumber). Local rows always take precedence
    // because they carry attemptCount + a real solutionNumber for the
    // modal.
    const localChainBlockNumbers = new Set(
      recentMiningSubmissions.map((s) => s.chainBlockNumber).filter((n): n is string => n != null),
    );
    const selfMinerType = chainMinerEntry?.hardware?.primaryType ?? "";
    const chainOnlyRows: MiningSubmissionRecord[] = selfBlocks
      .filter((b) => !localChainBlockNumbers.has(b.substrateBlockNumber))
      .map((b) => {
        // Global solution_number = the block's chain qblockId, so synthetic
        // rows match what local mining_submissions rows report (one numbering,
        // not two). Distinct from the substrate block height (the "Block"
        // column). Falls back to the 0 sentinel — which suppresses the modal
        // click — only if the chain didn't stamp a positive id.
        return {
          solutionNumber: qblockNumber(b) ?? 0,
          minerId: b.minerId,
          minerType: selfMinerType,
          // BlockRecord.timestamp is in seconds (substrate-worker
          // converts before insert). MiningSubmissionRecord.tsNs is
          // u128 nanoseconds-as-string; BigInt arithmetic preserves
          // precision past Number.MAX_SAFE_INTEGER.
          tsNs: String(BigInt(b.timestamp) * 1_000_000_000n),
          energyMilli: Math.round(b.energy * 1000),
          diversityMilli: Math.round(b.diversity * 1000),
          thresholdMilli: Math.round(b.difficultyEnergy * 1000),
          lastProofBlockHash: "",
          extrinsicHash: null,
          chainBlockHash: b.blockHash,
          chainBlockNumber: b.substrateBlockNumber,
          // Winners carry their block number (the "Block" column), not a
          // proofs_submitted sequence.
          powSequence: null,
          outcome: "submitted_inblock",
          attemptCount: 0,
          bestEnergyMilli: Math.round(b.energy * 1000),
          numValid: b.numValidSolutions,
          // Synthetic chain-only rows have no iteration data to sum
          // qpu_access_time_us from. Surface 0 — the QPU compute bar
          // simply omits these rows from its aggregation rather than
          // double-counting wall-clock for blocks we don't have local
          // attempts for.
          qpuAccessTimeUs: 0,
          observedAt: new Date(b.timestamp * 1000).toISOString(),
          chainOnly: true,
        };
      });
    // Merge then DESC-sort by tsNs (u128, BigInt-safe). Both row
    // sources stamp tsNs in the same nanosecond format so the
    // comparison is total.
    const recentSubmissions = [...recentMiningSubmissions, ...chainOnlyRows].sort((a, b) => {
      const aN = BigInt(a.tsNs);
      const bN = BigInt(b.tsNs);
      if (aN > bN) return -1;
      if (aN < bN) return 1;
      return 0;
    });

    // --- Chain-floored counters ---
    // Headline tiles ("Solutions Computed", "Proofs Submitted",
    // "Problems Attempted") flooring at chain proofsSubmitted so a
    // miner restart doesn't make the dashboard look like the operator
    // started over from scratch.
    const chainProofsSubmitted = Number(chainMinerEntry?.proofsSubmitted ?? "0");
    const localMinerStats = indexer?.minerStats ?? null;
    const effectiveMinerStats: MinerStats | null = localMinerStats
      ? {
          ...localMinerStats,
          proofsSubmitted: Math.max(localMinerStats.proofsSubmitted, chainProofsSubmitted),
        }
      : null;
    const effectiveProblemsAttempted = Math.max(selfProblemsAttempted, chainProofsSubmitted);

    // Network-wide unfiltered leaderboard for rank-neighbor lookup, ranked
    // by chain proofs_won with metrics joined from /api/miner-wins. We
    // deliberately ignore the UI store's `selectedTypes` filter here — the
    // operator's rank in the network is not category-scoped.
    const leaderboard = computeLeaderboard(chainMiners, minerWins, undefined, nodeDescriptors);
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
      modes: indexer?.modes,
      lastWonBlock,
      lastWonProblemNumber,
      recentSubmissions,
      effectiveMinerStats,
      effectiveProblemsAttempted,
      blocksMined,
      selfAvgMiningTimeSec,
      currentRequirements,
      self,
      neighbors,
    };
  }, [
    selfAddress,
    chainMiners,
    nodeDescriptors,
    blocks,
    minerWins,
    indexer,
    tipBlock,
    recentDifficulty,
    recentMiningSubmissions,
    selfProblemsAttempted,
  ]);
}
