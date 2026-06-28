// SPDX-License-Identifier: AGPL-3.0-or-later

import { shortAddress } from "../../../lib/format-chain";
import { useTelemetryStore } from "../../../store/telemetry-store";

/**
 * Per-topology difficulty panel. v0.2 keys difficulty by topology hash and
 * gates mining on a `MineableTopologies` whitelist; the indexer reads the
 * live decayed threshold per topology via `QuantumPowApi::difficulty_for`.
 * One row per mineable topology, with the default topology badged.
 *
 * Hidden when the chain predates per-topology difficulty (empty list) so the
 * panel doesn't show on older runtimes.
 */
export function MineableTopologiesPanel() {
  const topologies = useTelemetryStore((s) => s.mineableTopologies);
  if (topologies.length === 0) return null;

  return (
    <div className="mt-5 rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 backdrop-blur-xl">
      <header className="border-b border-brand-gray-2 px-4 py-3">
        <h2 className="font-heading text-lg text-brand-gray-5">
          Mineable Topologies ({topologies.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-brand-gray-3">
          Whitelisted puzzles from <code>quantum_pow.MineableTopologies</code>, each with its live
          per-topology difficulty (<code>difficulty_for</code>). Lower target energy is harder.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full font-accent text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-brand-gray-3">
            <tr className="border-b border-brand-gray-2">
              <th className="px-4 py-2">Topology</th>
              <th className="px-4 py-2 text-right">Nodes</th>
              <th className="px-4 py-2 text-right">Edges</th>
              <th className="px-4 py-2 text-right">Target Energy</th>
              <th className="px-4 py-2 text-right">Min Diversity</th>
              <th className="px-4 py-2 text-right">Min Solutions</th>
            </tr>
          </thead>
          <tbody>
            {topologies.map((t) => (
              <tr
                key={t.topologyHash}
                className="border-b border-brand-gray-1 last:border-b-0 hover:bg-brand-gray-2/30"
              >
                <td className="px-4 py-2 font-mono text-xs" title={t.topologyHash}>
                  {shortAddress(t.topologyHash)}
                  {t.isDefault && (
                    <span className="ml-2 rounded bg-brand-gray-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-brand-gray-5">
                      default
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{t.nodeCount}</td>
                <td className="px-4 py-2 text-right tabular-nums">{t.edgeCount}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {t.difficultyEnergy.toFixed(1)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{t.minDiversity.toFixed(1)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{t.minSolutions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
