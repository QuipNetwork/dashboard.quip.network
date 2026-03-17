import { Header } from "./Header";
import { ChartCard } from "./ChartCard";
import { BlocksOverTimeChart } from "../charts/BlocksOverTimeChart";
import { MiningTimeChart } from "../charts/MiningTimeChart";
import { ComputeUsedChart } from "../charts/ComputeUsedChart";
import { ActiveNodesChart } from "../charts/ActiveNodesChart";

export function Dashboard() {
  return (
    <div className="min-h-screen bg-brand-gray-0">
      <Header />
      <main className="mx-auto max-w-7xl p-6">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <ChartCard
            title="Blocks Mined Over Time"
            subtitle="Cumulative blocks per unit type"
            className="lg:col-span-2"
          >
            <BlocksOverTimeChart />
          </ChartCard>

          <ChartCard
            title="Mining Time per Block"
            subtitle="Time to solution by processor type"
          >
            <MiningTimeChart />
          </ChartCard>

          <ChartCard
            title="Total Compute Used"
            subtitle="Wall clock × units (CPU/GPU) or raw QPU time"
          >
            <ComputeUsedChart />
          </ChartCard>

          <ChartCard
            title="Mining Nodes by Type"
            subtitle="Distinct miners observed on network"
          >
            <ActiveNodesChart />
          </ChartCard>
        </div>
      </main>
    </div>
  );
}
