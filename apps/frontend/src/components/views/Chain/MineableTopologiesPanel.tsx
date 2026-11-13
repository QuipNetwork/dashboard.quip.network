// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatNumber } from "@/lib/format";
import { energyBandPosition } from "@/lib/difficulty-curve";
import {
  formatBandPosition,
  formatEnergy,
  formatEnergyBand,
  formatFamily,
  shortAddress,
} from "@/lib/format-chain";
import { SortableHeaderCell } from "@/components/common/SortableHeaderCell";
import { useTableSort, type SortAccessors } from "@/lib/table-sort";
import { useTelemetryStore } from "@/store/telemetry-store";
import type { MineableTopologyRecord } from "@quip/shared/telemetry";

type TopologySortColumn =
  | "topology"
  | "family"
  | "energyBand"
  | "difficultyEnergy"
  | "minDiversity"
  | "minSolutions"
  | "nodes"
  | "edges";

const SORT_ACCESSORS: SortAccessors<MineableTopologyRecord, TopologySortColumn> = {
  topology: (t) => t.topologyHash,
  family: (t) => (t.family ? formatFamily(t.family) : null),
  energyBand: (t) => t.energyBand?.hardEnergy ?? null,
  difficultyEnergy: (t) => t.difficultyEnergy,
  minDiversity: (t) => t.minDiversity,
  minSolutions: (t) => t.minSolutions,
  nodes: (t) => t.nodeCount,
  edges: (t) => t.edgeCount,
};

/**
 * Per-topology difficulty for the chain's mineable whitelist. v0.2 keys
 * difficulty by topology hash; the indexer reads the live decayed threshold
 * plus node/edge counts via the QuantumPow runtime APIs and the server ships
 * the current-state snapshot on `/api/telemetry.mineableTopologies`.
 *
 * A family topology (runtime 120+) shows its `family_id@revision` and the
 * energy band its difficulty moves inside. Its target energy is placed in
 * that band (0 = hard end, 1 = easy end) instead of on the legacy curve.
 *
 * Hides itself when the list is empty — pre-v0.2 chains (no runtime APIs) or
 * before the substrate worker's first poll completes.
 */
export function MineableTopologiesPanel() {
  const topologies = useTelemetryStore((s) => s.mineableTopologies);
  // Natural order (chain whitelist, default topology flagged inline) until a
  // header is clicked.
  const { sorted, sort, onSort } = useTableSort(topologies, SORT_ACCESSORS, null);
  if (topologies.length === 0) return null;
  return (
    <details className="mt-6 border border-border bg-white px-4 py-3" open>
      <summary className="cursor-pointer font-accent text-sm text-ink-body select-none">
        Mineable Topologies ({topologies.length})
      </summary>
      <div className="mt-3 overflow-auto">
        <table className="w-full font-mono text-xs text-ink-strong">
          <thead>
            <tr className="text-left font-accent text-ink-subtle">
              <SortableHeaderCell
                label="Topology"
                column="topology"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Family"
                column="family"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Energy Band"
                column="energyBand"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Difficulty Energy"
                column="difficultyEnergy"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Min Diversity"
                column="minDiversity"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Min Solutions"
                column="minSolutions"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Nodes"
                column="nodes"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
              <SortableHeaderCell
                label="Edges"
                column="edges"
                sort={sort}
                onClick={onSort}
                className="py-1 pr-4"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.topologyHash} className="border-t border-border">
                <td className="py-1 pr-4">
                  {shortAddress(t.topologyHash)}
                  {t.isDefault && (
                    <span className="ml-2 font-accent text-ink-subtle">— default</span>
                  )}
                </td>
                <td className="py-1 pr-4">{t.family ? formatFamily(t.family) : "—"}</td>
                <td className="py-1 pr-4">{t.energyBand ? formatEnergyBand(t.energyBand) : "—"}</td>
                <td className="py-1 pr-4">
                  {formatEnergy(t.difficultyEnergy)}
                  <BandPosition topology={t} />
                </td>
                <td className="py-1 pr-4">{formatNumber(t.minDiversity)}</td>
                <td className="py-1 pr-4">{formatNumber(t.minSolutions)}</td>
                <td className="py-1 pr-4">{formatNumber(t.nodeCount)}</td>
                <td className="py-1 pr-4">{formatNumber(t.edgeCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// Position of the target inside the band, for family topologies only.
function BandPosition({ topology }: { topology: MineableTopologyRecord }) {
  const position = energyBandPosition(topology.difficultyEnergy, topology.energyBand);
  if (position == null) return null;
  return (
    <span className="ml-2 font-accent text-ink-subtle" title="Band position: 0 = hard, 1 = easy">
      ({formatBandPosition(position)})
    </span>
  );
}
