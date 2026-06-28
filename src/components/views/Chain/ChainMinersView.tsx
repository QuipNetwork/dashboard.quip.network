// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { formatBalance, shortAddress } from "../../../lib/format-chain";
import { useTelemetryStore } from "../../../store/telemetry-store";

/**
 * On-chain miner table from `quantum_pow.Miners` storage. The cleanest
 * authoritative view of who's actually mining — distinct from the
 * telemetry-snapshot "nodes" list which is operator self-reported and
 * may include nodes that never submitted a successful proof.
 *
 * Lives here for historical reasons (extracted from the original
 * `ChainMinersView` wrapper); embedded by `ComputeAvailableView` since
 * v0.3. The Chain tab itself now renders the validator-centric
 * `ChainView` from `./ChainView`.
 */
export function ChainMinersTable() {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);

  // Index descriptors by accountId so the per-row join is O(1). useMemo
  // keeps the map stable across renders that don't change descriptors.
  const descriptorsByAccount = useMemo(() => {
    return new Map(nodeDescriptors.map((d) => [d.accountId, d]));
  }, [nodeDescriptors]);

  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 backdrop-blur-xl">
      <header className="border-b border-brand-gray-2 px-4 py-3">
        <h2 className="font-heading text-lg text-brand-gray-5">
          On-chain miners ({chainMiners.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-brand-gray-3">
          From <code>quantum_pow.Miners</code> storage. Sorted by lifetime rewards. Identity columns
          (rig name, version) joined from <code>MinerRegistry.NodeDescriptors</code>.
        </p>
      </header>
      {chainMiners.length === 0 ? (
        <p className="px-4 py-6 text-center font-accent text-sm text-brand-gray-3">
          No miners registered on chain yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-accent text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-brand-gray-3">
              <tr className="border-b border-brand-gray-2">
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2">Rig Name</th>
                <th className="px-4 py-2">Version</th>
                <th className="px-4 py-2 text-right">Deposit</th>
                <th className="px-4 py-2 text-right">Proofs Submitted</th>
                <th className="px-4 py-2 text-right">Proofs Won</th>
                <th className="px-4 py-2 text-right">Rewards</th>
              </tr>
            </thead>
            <tbody>
              {chainMiners.map((m) => {
                const d = descriptorsByAccount.get(m.accountId);
                return (
                  <tr
                    key={m.accountId}
                    className="border-b border-brand-gray-1 last:border-b-0 hover:bg-brand-gray-2/30"
                  >
                    <td className="px-4 py-2 font-mono text-xs" title={m.accountId}>
                      {shortAddress(m.accountId)}
                    </td>
                    <td className="px-4 py-2 text-brand-gray-5">
                      {d?.descriptor.nodeName ?? <span className="text-brand-gray-3">—</span>}
                    </td>
                    <td className="px-4 py-2 text-brand-gray-3">
                      {d?.descriptor.runtime?.quipVersion ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatBalance(m.deposit)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.proofsSubmitted}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.proofsWon}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatBalance(m.rewardsEarned)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
