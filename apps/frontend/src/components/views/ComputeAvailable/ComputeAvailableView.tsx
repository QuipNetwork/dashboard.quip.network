// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "@/components/layout/ChartCard";
import { decaysApplied } from "@/lib/decays";
import { winningSolutionsSolved } from "@/lib/chain-solutions";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { DifficultyChart } from "@/components/views/Chain/DifficultyChart";
import { RecentBlocksTable } from "@/components/views/Network/RecentBlocksTable";
import { ActiveNodesChart } from "@/components/charts/active-nodes/ActiveNodesChart";
import { BlocksOverTimeCard } from "@/components/charts/blocks-over-time/BlocksOverTimeCard";
import { ComputeUsedChart } from "@/components/charts/compute-used/ComputeUsedChart";
import { CumulativeBlocksThresholdChart } from "@/components/charts/cumulative-blocks-threshold/CumulativeBlocksThresholdChart";
import { EnergyCdfChart } from "@/components/charts/energy-cdf/EnergyCdfChart";
import { EnergyDistributionCard } from "@/components/charts/energy-distribution/EnergyDistributionCard";
import { LeaderboardCard } from "@/components/charts/leaderboard/LeaderboardCard";
import { MiningTimeCard } from "@/components/charts/mining-time/MiningTimeCard";
import { MiningTimeByDifficultyChart } from "@/components/charts/mining-time-by-difficulty/MiningTimeByDifficultyChart";
import { TimeToSolutionCard } from "@/components/charts/time-to-solution/TimeToSolutionCard";
import { WinRateByDifficultyChart } from "@/components/charts/win-rate-by-difficulty/WinRateByDifficultyChart";
import { useActiveNodes } from "@/components/charts/active-nodes/use-active-nodes";
import { useComputeUsed } from "@/components/charts/compute-used/use-compute-used";
import { CurrentQBlockDetailsCard } from "./CurrentQBlockDetailsCard";
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
  // (refreshed every chain poll). Falls back to the per-block snapshot from
  // the tip block when no live poll has landed yet. This is the identical
  // precedence chain `useMyNode` builds its `currentRequirements` from
  // (recentDifficulty[0] ?? tipBlock snapshot) — confirmed equivalent by
  // inspection — so CurrentQBlockDetailsCard takes the already-resolved
  // value here rather than importing the MyNode hook, keeping Compute's
  // difficulty source local to Compute's own data flow.
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);
  const liveDifficulty = recentDifficulty[0] ?? null;
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

  const computeUsed = useComputeUsed();
  const activeNodes = useActiveNodes();

  return (
    <>
      {/* Block-ceiling FLOPS + live difficulty — orthogonal to By Node / By
          Type, visible in both modes. Side-by-side on lg; stacks below. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <LastQBlockDetailsCard
          lastBlock={compute.lastBlock}
          lastBlockPflopSeconds={compute.lastBlockPflopSeconds}
        />
        <CurrentQBlockDetailsCard
          lastBlock={compute.lastBlock}
          currentBlockPflopSeconds={compute.currentBlockPflopSeconds}
          currentBlockElapsedSeconds={compute.currentBlockElapsedSeconds}
          currentDifficulty={currentDifficulty}
          recentDifficulty={recentDifficulty}
          decays={decays}
        />
      </div>

      <ChartCard title="Recent QBlocks" subtitle="Last 10 mined qblocks on the current chain tip">
        <RecentBlocksTable blocks={blocks} indexer={indexer} totalProofsWon={totalProofsWon} />
      </ChartCard>

      <LeaderboardCard />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <BlocksOverTimeCard />

        <MiningTimeCard />
      </div>

      {/* Full width per docs/ui-layout.md — the range-windowed time series
          needs the horizontal room; a half-column squashes the x-axis. */}
      <DifficultyChart />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard title="Total Compute Used" subtitle="Reported or estimated device time per win">
          <ComputeUsedChart data={computeUsed} />
        </ChartCard>

        {byType && (
          <ChartCard title="Mining Nodes by Type" subtitle="Distinct miners observed on network">
            <ActiveNodesChart data={activeNodes} />
          </ChartCard>
        )}

        <EnergyDistributionCard />

        <TimeToSolutionCard />

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
            <WinRateByDifficultyChart />
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
