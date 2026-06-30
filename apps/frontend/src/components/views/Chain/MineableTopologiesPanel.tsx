// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatNumber } from "@/lib/format";
import { formatEnergy, shortAddress } from "@/lib/format-chain";
import { useTelemetryStore } from "@/store/telemetry-store";

/**
 * Per-topology difficulty for the chain's mineable whitelist. v0.2 keys
 * difficulty by topology hash; the indexer reads the live decayed threshold
 * plus node/edge counts via the QuantumPow runtime APIs and the server ships
 * the current-state snapshot on `/api/telemetry.mineableTopologies`.
 *
 * Hides itself when the list is empty — pre-v0.2 chains (no runtime APIs) or
 * before the substrate worker's first poll completes.
 */
export function MineableTopologiesPanel() {
  const topologies = useTelemetryStore((s) => s.mineableTopologies);
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
              <th className="py-1 pr-4">Topology</th>
              <th className="py-1 pr-4">Difficulty Energy</th>
              <th className="py-1 pr-4">Min Diversity</th>
              <th className="py-1 pr-4">Min Solutions</th>
              <th className="py-1 pr-4">Nodes</th>
              <th className="py-1 pr-4">Edges</th>
            </tr>
          </thead>
          <tbody>
            {topologies.map((t) => (
              <tr key={t.topologyHash} className="border-t border-border">
                <td className="py-1 pr-4">
                  {shortAddress(t.topologyHash)}
                  {t.isDefault && (
                    <span className="ml-2 font-accent text-ink-subtle">— default</span>
                  )}
                </td>
                <td className="py-1 pr-4">{formatEnergy(t.difficultyEnergy)}</td>
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
