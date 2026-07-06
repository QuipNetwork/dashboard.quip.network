// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "@/components/layout/ChartCard";
import { SERIES_COLORS } from "@/lib/colors";
import { formatNumber } from "@/lib/format";
import { useUIStore } from "@/store/ui-store";
import { StatTile } from "@/components/views/MyNode/StatTile";
import { ChainMinersTable } from "@/components/views/Chain/ChainMinersView";
import { HardwareBreakdown } from "@/components/views/ComputeAvailable/HardwareBreakdown";
import { NodeLeaderboard } from "@/components/views/ComputeAvailable/NodeLeaderboard";
import { NodeLocationMap } from "@/components/views/ComputeAvailable/NodeLocationMap";
import { useComputeAvailable } from "@/components/views/ComputeAvailable/use-compute-available";

/**
 * Network tab — the node inventory: where the network's nodes are, what
 * hardware they run, and who's registered on chain. Mining/qblock analytics
 * live under Compute (see docs/ui-layout.md).
 */
export function NetworkView() {
  const compute = useComputeAvailable();
  const byNode = useUIStore((s) => s.aggregationMode) === "byNode";

  return (
    <>
      <ChartCard
        title="Node Locations (last 2 weeks)"
        subtitle={`${compute.locatedNodes.length} of ${compute.activeNodeCount} active nodes geo-located via publicHost`}
        bodyClassName="h-[440px]"
      >
        <NodeLocationMap nodes={compute.locatedNodes} unlocatedCount={compute.unlocatedCount} />
      </ChartCard>

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {byNode ? (
          <>
            <StatTile
              label="Total Nodes"
              value={formatNumber(compute.totalNodes)}
              sublabel="Unique nodes reporting"
            />
            <StatTile
              label="Top Node"
              value={compute.topNode ? `${compute.topNode.tflops.toFixed(1)} TFLOPS` : "—"}
              sublabel={compute.topNode?.nodeName ?? "No data"}
              accent={SERIES_COLORS.GPU}
            />
            <StatTile
              label="Median Node"
              value={`${compute.medianNodeTflops.toFixed(1)} TFLOPS`}
              sublabel="Per-node p50"
            />
            <StatTile
              label="Est. PFLOPS (last 2 weeks)"
              value={compute.totalPetaflops.toFixed(2)}
              sublabel={`Across ${compute.activeNodeCount} active nodes`}
            />
          </>
        ) : (
          <>
            <StatTile
              label="Total CPUs (last 2 weeks)"
              value={formatNumber(compute.totalCpus)}
              sublabel="Utilized CPUs across network, active in the last 2 weeks"
              accent={SERIES_COLORS.CPU}
            />
            <StatTile
              label="Total GPUs (last 2 weeks)"
              value={formatNumber(compute.totalGpus)}
              sublabel="Devices across network, active in the last 2 weeks"
              accent={SERIES_COLORS.GPU}
            />
            <StatTile
              label="Total QPUs (last 2 weeks)"
              value={formatNumber(compute.totalQpus)}
              sublabel="Quantum miners active in the last 2 weeks"
              accent={SERIES_COLORS.QPU}
            />
            <StatTile
              label="Est. PFLOPS (last 2 weeks)"
              value={compute.totalPetaflops.toFixed(2)}
              sublabel={`Across ${compute.activeNodeCount} active nodes`}
            />
          </>
        )}
      </div>

      <ChainMinersTable />

      {byNode ? (
        <div className="border border-border bg-white p-5">
          <div className="mb-4">
            <h2 className="font-heading text-lg text-ink-strong">Node Compute Contribution</h2>
            <p className="font-accent text-xs text-ink-subtle">
              Theoretical FP32 TFLOPS per node — {compute.perNodeTflops.length} nodes, sorted by
              contribution
            </p>
          </div>
          <NodeLeaderboard nodes={compute.perNodeTflops} accent="#67E347" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <ChartCard
            title="CPU Model Breakdown (last 2 weeks)"
            subtitle="Logical CPU populations on nodes active in the last 2 weeks"
            bodyClassName="max-h-[420px] overflow-y-auto"
          >
            <HardwareBreakdown
              data={compute.cpuModels}
              accent={SERIES_COLORS.CPU}
              emptyLabel="No CPU model data reported"
            />
          </ChartCard>

          <ChartCard
            title="GPU Model Breakdown (last 2 weeks)"
            subtitle="Devices by model on nodes active in the last 2 weeks"
            bodyClassName="max-h-[420px] overflow-y-auto"
          >
            <HardwareBreakdown
              data={compute.gpuModels}
              accent={SERIES_COLORS.GPU}
              emptyLabel="No GPU devices reported"
            />
          </ChartCard>
        </div>
      )}
    </>
  );
}
