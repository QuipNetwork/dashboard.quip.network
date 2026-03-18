import { Header } from "./Header";
import { ChartCard } from "./ChartCard";
import { BlocksOverTimeChart } from "../charts/BlocksOverTimeChart";
import { MiningTimeChart } from "../charts/MiningTimeChart";
import { ComputeUsedChart } from "../charts/ComputeUsedChart";
import { ActiveNodesChart } from "../charts/ActiveNodesChart";
import { useBlocksOverTime } from "../../hooks/use-blocks-over-time";
import { useMiningTime } from "../../hooks/use-mining-time";
import { useComputeUsed } from "../../hooks/use-compute-used";
import { useActiveNodes } from "../../hooks/use-active-nodes";

export function Dashboard() {
  const blocksOverTime = useBlocksOverTime();
  const miningTime = useMiningTime();
  const computeUsed = useComputeUsed();
  const activeNodes = useActiveNodes();

  return (
    <div className="relative min-h-screen bg-brand-gray-0">
      <div className="pointer-events-none fixed inset-0 bg-linear-to-b from-brand-gray-2/20 via-brand-gray-0 to-brand-gray-2/15" />
      <div className="relative">
        <Header />
        <main className="mx-auto max-w-7xl p-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ChartCard
              title="Blocks Mined Over Time"
              subtitle="Cumulative blocks per unit type"
              className="lg:col-span-2"
            >
              <BlocksOverTimeChart data={blocksOverTime} />
            </ChartCard>

            <ChartCard title="Mining Time per Block" subtitle="Time to solution by processor type">
              <MiningTimeChart data={miningTime} />
            </ChartCard>

            <ChartCard
              title="Total Compute Used"
              subtitle="Wall clock × units (CPU/GPU) or raw QPU time"
            >
              <ComputeUsedChart data={computeUsed} />
            </ChartCard>

            <ChartCard title="Mining Nodes by Type" subtitle="Distinct miners observed on network">
              <ActiveNodesChart data={activeNodes} />
            </ChartCard>
          </div>
        </main>
      </div>
    </div>
  );
}
