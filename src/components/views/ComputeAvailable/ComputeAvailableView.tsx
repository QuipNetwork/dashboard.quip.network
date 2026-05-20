// SPDX-License-Identifier: AGPL-3.0-or-later
import { useTelemetryStore } from "../../../store/telemetry-store";
import { shortAddress } from "../../../lib/format-chain";
import { formatDuration } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import { ChainMinersTable } from "../Chain/ChainMinersView";
import { DifficultyChart } from "../Chain/DifficultyChart";

const sourceLabel = (src: string | undefined): string => {
  if (src === "self") return "this node";
  if (src === "peer-query") return "peer query";
  if (src === "chain") return "on-chain";
  return "peer-query pending";
};

export function ComputeAvailableView() {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const serverTime = useTelemetryStore((s) => s.serverTime);
  const now = serverTime ? Date.parse(serverTime) : Date.now();

  const sorted = [...chainMiners].sort((a, b) => {
    const aHas = a.hardware !== null;
    const bHas = b.hardware !== null;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return a.accountId.localeCompare(b.accountId);
  });

  return (
    <>
      <ChartCard
        title="Hardware Inventory"
        subtitle="On-chain miners with available hardware data; others marked Unknown until peer-query lands."
        className="mb-5"
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left font-accent text-xs uppercase tracking-wider text-brand-gray-3">
                <th className="py-2 pr-4">Account</th>
                <th className="py-2 pr-4">Hardware</th>
                <th className="py-2 pr-4">Source</th>
                <th className="py-2">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="py-6 text-center font-accent text-sm text-brand-gray-3"
                  >
                    No on-chain miners registered yet.
                  </td>
                </tr>
              ) : (
                sorted.map((m) => (
                  <tr key={m.accountId} className="border-t border-brand-gray-2">
                    <td className="py-2 pr-4 font-mono text-sm text-brand-gray-6">
                      {shortAddress(m.accountId)}
                    </td>
                    <td className="py-2 pr-4 text-sm">
                      {m.hardware ? (
                        m.hardware.miners.map((mn) => `${mn.type}×1`).join(" + ")
                      ) : (
                        <span className="italic text-brand-gray-3">Unknown</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-sm text-brand-gray-4">
                      {sourceLabel(m.hardware?.source)}
                    </td>
                    <td className="py-2 text-sm text-brand-gray-4">
                      {m.hardware
                        ? `${formatDuration(now - Date.parse(m.hardware.observedAt))} ago`
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="mb-5">
        <ChainMinersTable />
      </div>

      <DifficultyChart />
    </>
  );
}
