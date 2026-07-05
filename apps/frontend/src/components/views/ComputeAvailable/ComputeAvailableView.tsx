// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "@/components/layout/ChartCard";
import { SERIES_COLORS } from "@/lib/colors";
import { decaysApplied } from "@/lib/decays";
import { formatDuration, formatNumber } from "@/lib/format";
import { formatEnergy } from "@/lib/format-chain";
import { winningSolutionsSolved } from "@/lib/chain-solutions";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { StatTile } from "@/components/views/MyNode/StatTile";
import { DifficultyChart } from "@/components/views/Chain/DifficultyChart";
import { RecentBlocksTable } from "@/components/views/Network/RecentBlocksTable";
import { ActiveNodesChart } from "@/components/charts/active-nodes/ActiveNodesChart";
import { BlocksOverTimeChart } from "@/components/charts/blocks-over-time/BlocksOverTimeChart";
import { ComputeUsedChart } from "@/components/charts/compute-used/ComputeUsedChart";
import { CumulativeBlocksThresholdChart } from "@/components/charts/cumulative-blocks-threshold/CumulativeBlocksThresholdChart";
import { EnergyCdfChart } from "@/components/charts/energy-cdf/EnergyCdfChart";
import { EnergyDistributionChart } from "@/components/charts/energy-distribution/EnergyDistributionChart";
import { Leaderboard } from "@/components/charts/leaderboard/Leaderboard";
import { MiningTimeCard } from "@/components/charts/mining-time/MiningTimeCard";
import { MiningTimeByDifficultyChart } from "@/components/charts/mining-time-by-difficulty/MiningTimeByDifficultyChart";
import { TimeToSolutionChart } from "@/components/charts/time-to-solution/TimeToSolutionChart";
import { WinRateByDifficultyChart } from "@/components/charts/win-rate-by-difficulty/WinRateByDifficultyChart";
import { useActiveNodes } from "@/components/charts/active-nodes/use-active-nodes";
import { useBlocksOverTime } from "@/components/charts/blocks-over-time/use-blocks-over-time";
import { useComputeUsed } from "@/components/charts/compute-used/use-compute-used";
import { useEnergyDistribution } from "@/components/charts/energy-distribution/use-energy-distribution";
import { useLeaderboard } from "@/components/charts/leaderboard/use-leaderboard";
import { useTimeToSolution } from "@/components/charts/time-to-solution/use-time-to-solution";
import { useWinRateByDifficulty } from "@/components/charts/win-rate-by-difficulty/use-win-rate-by-difficulty";
import { LastQBlockDetailsCard } from "./LastQBlockDetailsCard";
import { useComputeAvailable } from "./use-compute-available";

/**
 * Compute tab — mining/qblock analytics: block-scale FLOPS, the qblock feed,
 * the leaderboard, and the per-miner/per-type charts. The node inventory
 * (locations, hardware, on-chain miners) lives under Network (see
 * docs/ui-layout.md).
 */
export function ComputeAvailableView() {
  const compute = useComputeAvailable();
  const byType = useUIStore((s) => s.aggregationMode) === "byType";
  // v0.3 substrate worker is the sole writer — all blocks in the store are
  // canonical-by-construction (finalized substrate blocks only). The store
  // ships DESC by substrate_block_number, which is the order the table wants.
  const blocks = useTelemetryStore((s) => s.blocks);
  const indexer = useTelemetryStore((s) => s.indexer);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const chainHead = useTelemetryStore((s) => s.chainHead);
  // Chain-wide lifetime PoW solution count = LatestQBlockId, sourced from
  // chain via chain_head (falling back to summing per-miner proofs_won until
  // chain_head lands). u64, but values up to 2^53 fit Number safely.
  const totalProofsWon = winningSolutionsSolved(chainHead, chainMiners);

  // Live decayed difficulty from `current_difficulty()` runtime API
  // (refreshed every chain poll). Falls back to the per-block snapshot
  // from the tip block when no live poll has landed yet — same chain of
  // precedence used by the MyNode "Current Difficulty" detail card.
  const liveDifficulty = useTelemetryStore((s) => s.recentDifficulty[0] ?? null);
  const currentDifficulty =
    liveDifficulty ??
    (compute.lastBlock
      ? {
          difficultyEnergy: compute.lastBlock.difficultyEnergy,
          minDiversity: compute.lastBlock.minDiversity,
          minSolutions: compute.lastBlock.minSolutions,
        }
      : null);
  // Number of difficulty-decay steps applied since the last winning proof,
  // anchored on the BEST head (see lib/decays.ts for why finality lag made
  // the old finalized-anchored count misleading).
  const decays = decaysApplied(
    chainHead,
    compute.lastBlock ? compute.lastBlock.substrateBlockNumber : null,
  );

  const blocksOverTime = useBlocksOverTime();
  const computeUsed = useComputeUsed();
  const activeNodes = useActiveNodes();
  const energyDistribution = useEnergyDistribution();
  const timeToSolution = useTimeToSolution();
  const winRate = useWinRateByDifficulty();
  const leaderboard = useLeaderboard();

  return (
    <>
      {/* Block-ceiling FLOPS + live difficulty — orthogonal to By Node / By
          Type, visible in both modes. Three columns on lg; stacks below. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <LastQBlockDetailsCard
          lastBlock={compute.lastBlock}
          lastBlockPflopSeconds={compute.lastBlockPflopSeconds}
        />
        <StatTile
          label="Current Block FLOPS"
          value={
            compute.currentBlockPflopSeconds != null
              ? `${compute.currentBlockPflopSeconds.toFixed(1)} PFLOP·s`
              : "—"
          }
          sublabel={
            compute.lastBlock != null && compute.currentBlockElapsedSeconds != null
              ? `#${Number(compute.lastBlock.substrateBlockNumber) + 1} · ${formatDuration(compute.currentBlockElapsedSeconds * 1000)} and counting`
              : "Awaiting first block"
          }
          accent={SERIES_COLORS.QPU}
        />
        <StatTile
          label="Current Difficulty"
          value={
            currentDifficulty != null
              ? `≤ ${formatEnergy(currentDifficulty.difficultyEnergy)}`
              : "—"
          }
          sublabel={
            currentDifficulty != null
              ? `${decays != null ? `${decays} ${decays === 1 ? "decay" : "decays"} · ` : ""}min diversity ${currentDifficulty.minDiversity > 0 ? currentDifficulty.minDiversity.toFixed(2) : "—"} · min solutions ${currentDifficulty.minSolutions > 0 ? formatNumber(currentDifficulty.minSolutions) : "—"}`
              : "Awaiting first difficulty poll"
          }
          accent={SERIES_COLORS.CPU}
        />
      </div>

      <ChartCard title="Recent QBlocks" subtitle="Last 10 mined qblocks on the current chain tip">
        <RecentBlocksTable blocks={blocks} indexer={indexer} totalProofsWon={totalProofsWon} />
      </ChartCard>

      <ChartCard
        title="Mining Leaderboard"
        subtitle="Lifetime qblocks won, from on-chain proofs_won"
      >
        <Leaderboard data={leaderboard} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard
          title="QBlocks Mined Over Time"
          subtitle={byType ? "Cumulative qblocks per unit type" : "Cumulative qblocks per miner"}
        >
          <BlocksOverTimeChart data={blocksOverTime} />
        </ChartCard>

        <MiningTimeCard />
      </div>

      {/* Full width per docs/ui-layout.md — the range-windowed time series
          needs the horizontal room; a half-column squashes the x-axis. */}
      <DifficultyChart />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard
          title="Total Compute Used"
          subtitle={
            byType
              ? "Wall-clock for CPU/GPU · D-Wave anneal+readout time for QPU"
              : "Wall-clock (CPU/GPU) or D-Wave qpu_access_time (QPU) per miner"
          }
        >
          <ComputeUsedChart data={computeUsed} />
        </ChartCard>

        {byType && (
          <ChartCard title="Mining Nodes by Type" subtitle="Distinct miners observed on network">
            <ActiveNodesChart data={activeNodes} />
          </ChartCard>
        )}

        <ChartCard
          title="Energy Distribution"
          subtitle={
            byType
              ? "Normalised frequency per unit by energy"
              : "Normalised frequency per miner by energy"
          }
        >
          <EnergyDistributionChart data={energyDistribution} />
        </ChartCard>

        <ChartCard
          title="Time to QBlock"
          subtitle={
            byType
              ? "Normalised frequency per unit by mining time"
              : "Normalised frequency per miner by mining time"
          }
        >
          <TimeToSolutionChart data={timeToSolution} />
        </ChartCard>

        <ChartCard
          title="Probability of Meeting Difficulty"
          subtitle={
            byType
              ? "Empirical CDF of achieved energy by threshold"
              : "Empirical CDF per miner by threshold"
          }
        >
          <EnergyCdfChart />
        </ChartCard>

        {byType && (
          <ChartCard
            title="Win Rate by Difficulty"
            subtitle="Mining race win rate per processor type"
          >
            <WinRateByDifficultyChart data={winRate} />
          </ChartCard>
        )}

        <ChartCard
          title="Mining Cost by Difficulty"
          subtitle="Expected qblocks (or time) to reach a target, per processor type"
        >
          <MiningTimeByDifficultyChart />
        </ChartCard>

        <ChartCard
          title="Cumulative QBlocks by Threshold"
          subtitle={
            byType
              ? "QBlocks meeting energy threshold per type"
              : "QBlocks meeting energy threshold per miner"
          }
        >
          <CumulativeBlocksThresholdChart />
        </ChartCard>
      </div>
    </>
  );
}
