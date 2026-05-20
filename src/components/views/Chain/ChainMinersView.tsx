// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatBalance, shortAddress } from "../../../lib/format-chain";
import { useTelemetryStore } from "../../../store/telemetry-store";

import { BabeAuthoritiesPanel } from "./BabeAuthoritiesPanel";
import { DifficultyChart } from "./DifficultyChart";

/**
 * On-chain miner table from `quantum_pow.Miners` storage. The cleanest
 * authoritative view of who's actually mining — distinct from the
 * telemetry-snapshot "nodes" list which is operator self-reported and
 * may include nodes that never submitted a successful proof.
 *
 * Extracted from ChainMinersView so the Compute Available view can embed
 * the same table without pulling in DifficultyChart / BabeAuthoritiesPanel.
 */
export function ChainMinersTable() {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);

  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 backdrop-blur-xl">
      <header className="border-b border-brand-gray-2 px-4 py-3">
        <h2 className="font-heading text-lg text-brand-gray-5">
          On-chain miners ({chainMiners.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-brand-gray-3">
          From <code>quantum_pow.Miners</code> storage. Sorted by lifetime rewards.
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
                <th className="px-4 py-2">Telemetry Node</th>
                <th className="px-4 py-2 text-right">Deposit</th>
                <th className="px-4 py-2 text-right">Proofs Submitted</th>
                <th className="px-4 py-2 text-right">Proofs Won</th>
                <th className="px-4 py-2 text-right">Rewards</th>
              </tr>
            </thead>
            <tbody>
              {chainMiners.map((m) => (
                <tr
                  key={m.accountId}
                  className="border-b border-brand-gray-1 last:border-b-0 hover:bg-brand-gray-2/30"
                >
                  <td className="px-4 py-2 font-mono text-xs" title={m.accountId}>
                    {shortAddress(m.accountId)}
                  </td>
                  <td className="px-4 py-2 text-brand-gray-3">
                    {m.telemetryNodeAddress ? shortAddress(m.telemetryNodeAddress) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatBalance(m.deposit)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{m.proofsSubmitted}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{m.proofsWon}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatBalance(m.rewardsEarned)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Chain view composing the difficulty chart, on-chain miners table, and
 * BABE authorities panel. Renders an empty-state when neither chain miners
 * nor authorities are populated — that's the signal that
 * `QUIP_VALIDATOR_RPC_URL` is unset on the indexer.
 */
export function ChainMinersView() {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const babeAuthorities = useTelemetryStore((s) => s.babeAuthorities);

  if (chainMiners.length === 0 && babeAuthorities.length === 0) {
    return (
      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-12 text-center backdrop-blur-xl">
        <p className="font-heading text-2xl text-brand-gray-5">No substrate data</p>
        <p className="mt-2 font-accent text-sm text-brand-gray-3">
          Set <code>QUIP_VALIDATOR_RPC_URL</code> on the indexer to surface on-chain miner state and
          validator authorities here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Difficulty chart sits at the top — most visually informative and
          ties the rest of the chain surface to the BlockRecord requirements
          already familiar from the Network view. */}
      <DifficultyChart />
      <ChainMinersTable />
      <BabeAuthoritiesPanel />
    </div>
  );
}
