// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "@/components/layout/ChartCard";
import { SERIES_COLORS } from "@/lib/colors";
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
import { MiningTimeChart } from "@/components/charts/mining-time/MiningTimeChart";
import { MiningTimeByDifficultyChart } from "@/components/charts/mining-time-by-difficulty/MiningTimeByDifficultyChart";
import { TimeToSolutionChart } from "@/components/charts/time-to-solution/TimeToSolutionChart";
import { WinRateByDifficultyChart } from "@/components/charts/win-rate-by-difficulty/WinRateByDifficultyChart";
import { useActiveNodes } from "@/components/charts/active-nodes/use-active-nodes";
import { useBlocksOverTime } from "@/components/charts/blocks-over-time/use-blocks-over-time";
import { useComputeUsed } from "@/components/charts/compute-used/use-compute-used";
import { useCumulativeBlocksThreshold } from "@/components/charts/cumulative-blocks-threshold/use-cumulative-blocks-threshold";
import { useEnergyCdf } from "@/components/charts/energy-cdf/use-energy-cdf";
import { useEnergyDistribution } from "@/components/charts/energy-distribution/use-energy-distribution";
import { useLeaderboard } from "@/components/charts/leaderboard/use-leaderboard";
import { useMiningTime } from "@/components/charts/mining-time/use-mining-time";
import { useTimeToSolution } from "@/components/charts/time-to-solution/use-time-to-solution";
import { useWinRateByDifficulty } from "@/components/charts/win-rate-by-difficulty/use-win-rate-by-difficulty";
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
  // Number of difficulty-decay steps applied since the last winning proof.
  // Matches quip-protocol-rs `apply_decay` (pallets/quantum-pow/src/
  // difficulty.rs:261): one step per `QuantumPowEpochLength = 100` blocks
  // past `LastProofBlock`. Same hard-coded constant as `CurrentBlockIndicator`.
  const QUANTUM_POW_EPOCH_LENGTH = 100;
  const finalizedNum =
    chainHead && chainHead.finalizedBlockNumber ? Number(chainHead.finalizedBlockNumber) : null;
  const lastProofBlockNum = compute.lastBlock
    ? Number(compute.lastBlock.substrateBlockNumber)
    : null;
  const decaysApplied =
    finalizedNum != null && lastProofBlockNum != null
      ? Math.max(0, Math.floor((finalizedNum - lastProofBlockNum) / QUANTUM_POW_EPOCH_LENGTH))
      : null;

  const blocksOverTime = useBlocksOverTime();
  const miningTime = useMiningTime();
  const computeUsed = useComputeUsed();
  const activeNodes = useActiveNodes();
  const energyDistribution = useEnergyDistribution();
  const timeToSolution = useTimeToSolution();
  const energyCdf = useEnergyCdf();
  const winRate = useWinRateByDifficulty();
  const cumulativeBlocks = useCumulativeBlocksThreshold();
  const leaderboard = useLeaderboard();

  return (
    <>
      {/* Block-ceiling FLOPS + live difficulty — orthogonal to By Node / By
          Type, visible in both modes. Three columns on lg; stacks below. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <StatTile
          label="Last Block FLOPS"
          value={
            compute.lastBlockPflopSeconds != null
              ? `${compute.lastBlockPflopSeconds.toFixed(1)} PFLOP·s`
              : "—"
          }
          sublabel={
            compute.lastBlock != null
              ? `#${compute.lastBlock.substrateBlockNumber} · solved in ${formatDuration(compute.lastBlock.miningTime * 1000)}`
              : "Awaiting first block"
          }
          accent={SERIES_COLORS.GPU}
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
              ? `${decaysApplied != null ? `${decaysApplied} ${decaysApplied === 1 ? "decay" : "decays"} · ` : ""}min diversity ${currentDifficulty.minDiversity > 0 ? currentDifficulty.minDiversity.toFixed(2) : "—"} · min solutions ${currentDifficulty.minSolutions > 0 ? formatNumber(currentDifficulty.minSolutions) : "—"}`
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

        <ChartCard
          title="Mining Time per QBlock"
          subtitle={byType ? "Time to qblock by processor type" : "Time to qblock by miner"}
        >
          <MiningTimeChart data={miningTime} />
        </ChartCard>

        <DifficultyChart />

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
          title="Mining Cost by Difficulty"
          subtitle="Expected qblocks (or time) to reach a target, from the energy distribution"
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
          <CumulativeBlocksThresholdChart data={cumulativeBlocks} />
        </ChartCard>
      </div>
    </>
  );
}
