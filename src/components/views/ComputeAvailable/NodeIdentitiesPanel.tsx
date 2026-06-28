// SPDX-License-Identifier: AGPL-3.0-or-later

import { shortAddress } from "../../../lib/format-chain";
import { useTelemetryStore } from "../../../store/telemetry-store";
import type { NodeDescriptorRecord } from "../../../types/telemetry";

/**
 * Per-account chain-signed identity panel. One row per operator, sourced
 * from the `MinerRegistry.NodeDescriptors` storage map. Displays the
 * operator's self-asserted rig name + hardware inventory alongside the SS58
 * account that filed it.
 *
 * Hidden when no descriptors exist — the dashboard is useful well before
 * operators register, and an empty stub panel would just be noise.
 */
export function NodeIdentitiesPanel() {
  const descriptors = useTelemetryStore((s) => s.nodeDescriptors);
  if (descriptors.length === 0) return null;

  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 backdrop-blur-xl">
      <header className="border-b border-brand-gray-2 px-4 py-3">
        <h2 className="font-heading text-lg text-brand-gray-5">
          Node Identities ({descriptors.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-brand-gray-3">
          Self-asserted operator inventory from the <code>MinerRegistry</code> pallet. Identity is
          signed by the AccountId; hardware claims are operator-controlled, not chain-verified.
        </p>
      </header>
      <div className="divide-y divide-brand-gray-2">
        {descriptors.map((d) => (
          <NodeRow key={d.accountId} record={d} />
        ))}
      </div>
    </div>
  );
}

function NodeRow({ record }: { record: NodeDescriptorRecord }) {
  const d = record.descriptor;
  const minerEntries = d.miners ?? [];
  const gpus = d.systemInfo?.gpus ?? [];
  // The v0.2 on-chain descriptor no longer carries a per-miner CPU count, so
  // the host hardware survey (`systemInfo.cpu.logicalCores`, schema-v2 only)
  // is the only CPU-core signal available.
  const cpuCores = d.systemInfo?.cpu?.logicalCores ?? 0;
  const cpuLine = d.systemInfo?.cpu?.brand
    ? `${d.systemInfo.cpu.brand}${
        cpuCores > 0 ? ` (${cpuCores} core${cpuCores === 1 ? "" : "s"})` : ""
      }`
    : null;

  return (
    <div className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[1fr_2fr]">
      <div>
        <div className="font-heading text-base text-brand-gray-5">{d.nodeName}</div>
        <div className="mt-1 font-mono text-xs text-brand-gray-3" title={record.accountId}>
          {shortAddress(record.accountId)}
        </div>
        <div className="mt-2 flex flex-wrap gap-1 font-accent text-[10px] uppercase tracking-wider">
          {d.runtime?.quipVersion && <Badge label={`quip ${d.runtime.quipVersion}`} tone="info" />}
          {d.runtime?.inDocker && <Badge label="docker" tone="muted" />}
          {d.autoMine && <Badge label="auto-mine" tone="success" />}
        </div>
      </div>
      <div className="space-y-2 font-accent text-xs">
        {cpuLine && (
          <div>
            <span className="text-brand-gray-3">CPU:</span>{" "}
            <span className="text-brand-gray-5">{cpuLine}</span>
          </div>
        )}
        {gpus.length > 0 && (
          <div>
            <span className="text-brand-gray-3">
              GPU{gpus.length > 1 ? `s (${gpus.length})` : ""}:
            </span>{" "}
            <span className="text-brand-gray-5">
              {gpus.map((g) => g.name ?? "unknown").join(", ")}
            </span>
          </div>
        )}
        {minerEntries.length > 0 && (
          <div>
            <span className="text-brand-gray-3">Miners:</span>{" "}
            <span className="text-brand-gray-5">
              {minerEntries.map((m) => (m.label ? `${m.kind}/${m.label}` : m.kind)).join(" · ")}
            </span>
          </div>
        )}
        {d.publicHost && (
          <div>
            <span className="text-brand-gray-3">Reachable:</span>{" "}
            <span className="text-brand-gray-5">
              {d.publicHost}
              {d.publicPort ? `:${d.publicPort}` : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: "info" | "muted" | "success" }) {
  const cls =
    tone === "info"
      ? "bg-brand-gray-2 text-brand-gray-5"
      : tone === "success"
        ? "bg-brand-green-0/20 text-brand-green-0"
        : "bg-brand-gray-1 text-brand-gray-3";
  return <span className={`rounded px-2 py-0.5 ${cls}`}>{label}</span>;
}
