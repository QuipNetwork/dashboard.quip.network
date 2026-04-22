// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { ChartCard } from "../../layout/ChartCard";
import { BlocksOverTimeChart } from "../../charts/blocks-over-time/BlocksOverTimeChart";
import { MiningTimeChart } from "../../charts/mining-time/MiningTimeChart";
import { ComputeUsedChart } from "../../charts/compute-used/ComputeUsedChart";
import { ActiveNodesChart } from "../../charts/active-nodes/ActiveNodesChart";
import { EnergyDistributionChart } from "../../charts/energy-distribution/EnergyDistributionChart";
import { TimeToSolutionChart } from "../../charts/time-to-solution/TimeToSolutionChart";
import { EnergyCdfChart } from "../../charts/energy-cdf/EnergyCdfChart";
import { WinRateByDifficultyChart } from "../../charts/win-rate-by-difficulty/WinRateByDifficultyChart";
import { MiningTimeByDifficultyChart } from "../../charts/mining-time-by-difficulty/MiningTimeByDifficultyChart";
import { CumulativeBlocksThresholdChart } from "../../charts/cumulative-blocks-threshold/CumulativeBlocksThresholdChart";
import { Leaderboard } from "../../charts/leaderboard/Leaderboard";
import { useBlocksOverTime } from "../../charts/blocks-over-time/use-blocks-over-time";
import { useMiningTime } from "../../charts/mining-time/use-mining-time";
import { useComputeUsed } from "../../charts/compute-used/use-compute-used";
import { useActiveNodes } from "../../charts/active-nodes/use-active-nodes";
import { useEnergyDistribution } from "../../charts/energy-distribution/use-energy-distribution";
import { useTimeToSolution } from "../../charts/time-to-solution/use-time-to-solution";
import { useEnergyCdf } from "../../charts/energy-cdf/use-energy-cdf";
import { useWinRateByDifficulty } from "../../charts/win-rate-by-difficulty/use-win-rate-by-difficulty";
import { useMiningTimeByDifficulty } from "../../charts/mining-time-by-difficulty/use-mining-time-by-difficulty";
import { useCumulativeBlocksThreshold } from "../../charts/cumulative-blocks-threshold/use-cumulative-blocks-threshold";
import { useLeaderboard } from "../../charts/leaderboard/use-leaderboard";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";
import { RecentBlocksTable } from "./RecentBlocksTable";

export function NetworkView() {
  const byType = useUIStore((s) => s.aggregationMode) === "byType";
  const allBlocks = useTelemetryStore((s) => s.blocks);
  const indexer = useTelemetryStore((s) => s.indexer);

  // Canonical chain only: the server's default ORDER BY (timestamp,
  // block_index) interleaves blocks from abandoned branches that share
  // timestamps with the winning chain. Filter to the tip block's epoch and
  // sort by block_index so the "Recent Blocks" table strictly follows the
  // current version of the chain.
  const canonicalChainBlocks = useMemo(() => {
    if (allBlocks.length === 0) return allBlocks;
    const tipEpoch = allBlocks[allBlocks.length - 1]!.epoch;
    return allBlocks
      .filter((b) => b.epoch === tipEpoch)
      .sort((a, b) => a.blockIndex - b.blockIndex);
  }, [allBlocks]);

  const blocksOverTime = useBlocksOverTime();
  const miningTime = useMiningTime();
  const computeUsed = useComputeUsed();
  const activeNodes = useActiveNodes();
  const energyDistribution = useEnergyDistribution();
  const timeToSolution = useTimeToSolution();
  const energyCdf = useEnergyCdf();
  const winRate = useWinRateByDifficulty();
  const miningTimeByDifficulty = useMiningTimeByDifficulty();
  const cumulativeBlocks = useCumulativeBlocksThreshold();
  const leaderboard = useLeaderboard();

  return (
    <>
      <ChartCard
        title="Recent Blocks"
        subtitle="Last 10 completed blocks on the current chain tip"
        className="mb-5"
      >
        <RecentBlocksTable blocks={canonicalChainBlocks} indexer={indexer} />
      </ChartCard>

      <ChartCard
        title="Mining Leaderboard"
        subtitle="Top performing nodes by blocks mined"
        className="mb-5"
      >
        <Leaderboard data={leaderboard} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard
          title="Blocks Mined Over Time"
          subtitle={byType ? "Cumulative blocks per unit type" : "Cumulative blocks per miner"}
        >
          <BlocksOverTimeChart data={blocksOverTime} />
        </ChartCard>

        <ChartCard
          title="Mining Time per Block"
          subtitle={byType ? "Time to solution by processor type" : "Time to solution by miner"}
        >
          <MiningTimeChart data={miningTime} />
        </ChartCard>

        <ChartCard
          title="Total Compute Used"
          subtitle={
            byType ? "Wall clock × units (CPU/GPU) or raw QPU time" : "Wall clock × units per miner"
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
          title="Time to Solution"
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
          <EnergyCdfChart data={energyCdf} />
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
          title="Expected Mining Time by Difficulty"
          subtitle={
            byType
              ? "Mean time to solution per difficulty band"
              : "Mean time to solution per miner by difficulty"
          }
        >
          <MiningTimeByDifficultyChart data={miningTimeByDifficulty} />
        </ChartCard>

        <ChartCard
          title="Cumulative Blocks by Threshold"
          subtitle={
            byType
              ? "Blocks meeting energy threshold per unit"
              : "Blocks meeting energy threshold per miner"
          }
        >
          <CumulativeBlocksThresholdChart data={cumulativeBlocks} />
        </ChartCard>
      </div>
    </>
  );
}
