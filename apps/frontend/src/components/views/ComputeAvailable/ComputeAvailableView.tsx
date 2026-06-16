// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "@/components/layout/ChartCard";
import { SERIES_COLORS } from "@/lib/colors";
import { formatDuration, formatNumber } from "@/lib/format";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { StatTile } from "@/components/views/MyNode/StatTile";
import { ChainMinersTable } from "@/components/views/Chain/ChainMinersView";
import { DifficultyChart } from "@/components/views/Chain/DifficultyChart";
import { HardwareBreakdown } from "./HardwareBreakdown";
import { NodeIdentitiesPanel } from "./NodeIdentitiesPanel";
import { NodeLeaderboard } from "./NodeLeaderboard";
import { NodeLocationMap } from "./NodeLocationMap";
import { useComputeAvailable } from "./use-compute-available";

export function ComputeAvailableView() {
  const compute = useComputeAvailable();
  const byNode = useUIStore((s) => s.aggregationMode) === "byNode";
  // Live decayed difficulty from `current_difficulty()` runtime API
  // (refreshed every chain poll). Falls back to the per-block snapshot
  // from the tip block when no live poll has landed yet — same chain of
  // precedence used by the MyNode "Current Difficulty" detail card.
  const liveDifficulty = useTelemetryStore((s) => s.recentDifficulty[0] ?? null);
  const chainHead = useTelemetryStore((s) => s.chainHead);
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

  return (
    <>
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
              sublabel="Utilized CPUs across network"
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
            currentDifficulty != null ? `≤ ${currentDifficulty.difficultyEnergy.toFixed(1)}` : "—"
          }
          sublabel={
            currentDifficulty != null
              ? `${decaysApplied != null ? `${decaysApplied} ${decaysApplied === 1 ? "decay" : "decays"} · ` : ""}min diversity ${currentDifficulty.minDiversity > 0 ? currentDifficulty.minDiversity.toFixed(2) : "—"} · min solutions ${currentDifficulty.minSolutions > 0 ? formatNumber(currentDifficulty.minSolutions) : "—"}`
              : "Awaiting first difficulty poll"
          }
          accent={SERIES_COLORS.CPU}
        />
      </div>

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

      {/* v0.2 additions: chain-side miners table + difficulty chart land
          under the same view since they describe network-wide compute state. */}
      <ChartCard
        title="Node Locations"
        subtitle={`${compute.locatedNodes.length} of ${compute.totalNodes} nodes geo-located via publicHost`}
        bodyClassName="h-[440px]"
      >
        <NodeLocationMap nodes={compute.locatedNodes} unlocatedCount={compute.unlocatedCount} />
      </ChartCard>

      <ChainMinersTable />

      <NodeIdentitiesPanel />

      <DifficultyChart />
    </>
  );
}
