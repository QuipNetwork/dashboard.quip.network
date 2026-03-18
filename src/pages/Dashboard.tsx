import { Header } from "../components/layout/Header";
import { ChartCard } from "../components/layout/ChartCard";
import { BlocksOverTimeChart } from "../components/charts/blocks-over-time/BlocksOverTimeChart";
import { MiningTimeChart } from "../components/charts/mining-time/MiningTimeChart";
import { ComputeUsedChart } from "../components/charts/compute-used/ComputeUsedChart";
import { ActiveNodesChart } from "../components/charts/active-nodes/ActiveNodesChart";
import { EnergyDistributionChart } from "../components/charts/energy-distribution/EnergyDistributionChart";
import { TimeToSolutionChart } from "../components/charts/time-to-solution/TimeToSolutionChart";
import { EnergyCdfChart } from "../components/charts/energy-cdf/EnergyCdfChart";
import { WinRateByDifficultyChart } from "../components/charts/win-rate-by-difficulty/WinRateByDifficultyChart";
import { MiningTimeByDifficultyChart } from "../components/charts/mining-time-by-difficulty/MiningTimeByDifficultyChart";
import { CumulativeBlocksThresholdChart } from "../components/charts/cumulative-blocks-threshold/CumulativeBlocksThresholdChart";
import { useBlocksOverTime } from "../components/charts/blocks-over-time/use-blocks-over-time";
import { useMiningTime } from "../components/charts/mining-time/use-mining-time";
import { useComputeUsed } from "../components/charts/compute-used/use-compute-used";
import { useActiveNodes } from "../components/charts/active-nodes/use-active-nodes";
import { useEnergyDistribution } from "../components/charts/energy-distribution/use-energy-distribution";
import { useTimeToSolution } from "../components/charts/time-to-solution/use-time-to-solution";
import { useEnergyCdf } from "../components/charts/energy-cdf/use-energy-cdf";
import { useWinRateByDifficulty } from "../components/charts/win-rate-by-difficulty/use-win-rate-by-difficulty";
import { useMiningTimeByDifficulty } from "../components/charts/mining-time-by-difficulty/use-mining-time-by-difficulty";
import { useCumulativeBlocksThreshold } from "../components/charts/cumulative-blocks-threshold/use-cumulative-blocks-threshold";
import { Leaderboard } from "../components/charts/leaderboard/Leaderboard";
import { useLeaderboard } from "../components/charts/leaderboard/use-leaderboard";
import { useTelemetryStore } from "../store/telemetry-store";
import { useUIStore } from "../store/ui-store";

export function Dashboard() {
  const loading = useTelemetryStore((s) => s.loading);
  const error = useTelemetryStore((s) => s.error);
  const mode = useUIStore((s) => s.aggregationMode);
  const byType = mode === "byType";

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
    <div className="relative min-h-screen bg-brand-gray-0">
      <div className="pointer-events-none fixed inset-0 bg-linear-to-b from-brand-gray-2/20 via-brand-gray-0 to-brand-gray-2/15" />
      <div className="relative">
        <Header />
        <main className="mx-auto max-w-7xl p-6">
          {loading && (
            <p className="py-20 text-center font-accent text-brand-gray-3">Loading telemetry…</p>
          )}
          {error && <p className="py-20 text-center font-accent text-brand-red-0">{error}</p>}
          <div className={loading || error ? "hidden" : ""}>
            <ChartCard
              title="Mining Leaderboard"
              subtitle="Top performing nodes by blocks mined"
              className="mb-5"
            >
              <Leaderboard data={leaderboard} />
            </ChartCard>
          </div>
          <div
            className={`grid grid-cols-1 gap-5 lg:grid-cols-2${loading || error ? " hidden" : ""}`}
          >
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
              subtitle={byType ? "Wall clock × units (CPU/GPU) or raw QPU time" : "Wall clock × units per miner"}
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
              subtitle={byType ? "Normalised frequency per unit by energy" : "Normalised frequency per miner by energy"}
            >
              <EnergyDistributionChart data={energyDistribution} />
            </ChartCard>

            <ChartCard
              title="Time to Solution"
              subtitle={byType ? "Normalised frequency per unit by mining time" : "Normalised frequency per miner by mining time"}
            >
              <TimeToSolutionChart data={timeToSolution} />
            </ChartCard>

            <ChartCard
              title="Probability of Meeting Difficulty"
              subtitle={byType ? "Empirical CDF of achieved energy by threshold" : "Empirical CDF per miner by threshold"}
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
              subtitle={byType ? "Mean time to solution per difficulty band" : "Mean time to solution per miner by difficulty"}
            >
              <MiningTimeByDifficultyChart data={miningTimeByDifficulty} />
            </ChartCard>

            <ChartCard
              title="Cumulative Blocks by Threshold"
              subtitle={byType ? "Blocks meeting energy threshold per unit" : "Blocks meeting energy threshold per miner"}
            >
              <CumulativeBlocksThresholdChart data={cumulativeBlocks} />
            </ChartCard>
          </div>
        </main>
      </div>
    </div>
  );
}
