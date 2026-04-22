// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "../../layout/ChartCard";
import { SERIES_COLORS } from "../../../lib/colors";
import { formatNumber } from "../../../lib/format";
import { useUIStore } from "../../../store/ui-store";
import { StatTile } from "../MyNode/StatTile";
import { HardwareBreakdown } from "./HardwareBreakdown";
import { NodeLeaderboard } from "./NodeLeaderboard";
import { NodeLocationMap } from "./NodeLocationMap";
import { useComputeAvailable } from "./use-compute-available";

export function ComputeAvailableView() {
  const compute = useComputeAvailable();
  const byNode = useUIStore((s) => s.aggregationMode) === "byNode";

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-5 lg:grid-cols-4">
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
              label="Est. PFLOPS"
              value={compute.totalPetaflops.toFixed(2)}
              sublabel={`Across ${compute.totalNodes} nodes`}
            />
          </>
        ) : (
          <>
            <StatTile
              label="Total CPUs"
              value={formatNumber(compute.totalCpus)}
              sublabel="Logical cores across network"
              accent={SERIES_COLORS.CPU}
            />
            <StatTile
              label="Total GPUs"
              value={formatNumber(compute.totalGpus)}
              sublabel="Devices across network"
              accent={SERIES_COLORS.GPU}
            />
            <StatTile
              label="Total QPUs"
              value={formatNumber(compute.totalQpus)}
              sublabel="Active quantum miners"
              accent={SERIES_COLORS.QPU}
            />
            <StatTile
              label="Est. PFLOPS"
              value={compute.totalPetaflops.toFixed(2)}
              sublabel={`Across ${compute.totalNodes} nodes`}
            />
          </>
        )}
      </div>

      {byNode ? (
        <div className="mb-5 rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-5 backdrop-blur-xl">
          <div className="mb-4">
            <h2 className="font-heading text-lg text-brand-gray-5">Node Compute Contribution</h2>
            <p className="font-accent text-xs text-brand-gray-3">
              Theoretical FP32 TFLOPS per node — {compute.perNodeTflops.length} nodes, sorted by
              contribution
            </p>
          </div>
          <NodeLeaderboard nodes={compute.perNodeTflops} accent="#67E347" />
        </div>
      ) : (
        <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <ChartCard title="CPU Model Breakdown" subtitle="Logical CPU populations on the network">
            <HardwareBreakdown
              data={compute.cpuModels}
              accent={SERIES_COLORS.CPU}
              emptyLabel="No CPU model data reported"
            />
          </ChartCard>

          <ChartCard title="GPU Model Breakdown" subtitle="Devices by model across all nodes">
            <HardwareBreakdown
              data={compute.gpuModels}
              accent={SERIES_COLORS.GPU}
              emptyLabel="No GPU devices reported"
            />
          </ChartCard>
        </div>
      )}

      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-5 backdrop-blur-xl">
        <div className="mb-4">
          <h2 className="font-heading text-lg text-brand-gray-5">Node Locations</h2>
          <p className="font-accent text-xs text-brand-gray-3">
            Geo-IP derived from <code>publicHost</code>; marker size scales with estimated TFLOPS
          </p>
        </div>
        <div className="h-[440px]">
          <NodeLocationMap nodes={compute.locatedNodes} unlocatedCount={compute.unlocatedCount} />
        </div>
      </div>
    </>
  );
}
