// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";
import { useState } from "react";

import { shortAddress } from "@/lib/format-chain";
import { useTelemetryStore } from "@/store/telemetry-store";
import type { NodeDescriptorRecord } from "@/types/telemetry";
import { SearchInput } from "@/components/common/SearchInput";

export function filterNodeDescriptors(
  descriptors: readonly NodeDescriptorRecord[],
  query: string,
): NodeDescriptorRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...descriptors];
  return descriptors.filter(
    (d) =>
      d.accountId.toLowerCase().includes(q) ||
      (d.descriptor.nodeName?.toLowerCase().includes(q) ?? false),
  );
}

/**
 * Per-account chain-signed identity panel. One row per operator, sourced
 * from `MinerRegistry.NodeDescriptors` entries carrying a compact
 * `quip.node_descriptor.v1` payload. Displays the
 * operator's self-asserted rig name + hardware inventory + runtime
 * version alongside the SS58 account that signed it.
 *
 * Hidden when no descriptors exist — the dashboard is useful well before
 * operators register, and an empty stub panel would just be noise.
 */
export function NodeIdentitiesPanel() {
  const descriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const [query, setQuery] = useState("");
  if (descriptors.length === 0) return null;

  const filtered = filterNodeDescriptors(descriptors, query);

  return (
    <div className="border border-border bg-white">
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-heading text-lg text-ink-strong">
          Node Identities ({descriptors.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-ink-subtle">
          Self-asserted operator inventory from <code>MinerRegistry.NodeDescriptors</code>. Identity
          is signed by the AccountId; hardware claims are operator-controlled, not chain-verified.
        </p>
      </header>
      <div className="border-b border-border px-4 py-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search nodes…" />
      </div>
      {filtered.length === 0 ? (
        <p className="px-4 py-6 text-center font-accent text-sm text-ink-subtle">
          No nodes match “{query}”
        </p>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((d) => (
            <NodeRow key={d.accountId} record={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeRow({ record }: { record: NodeDescriptorRecord }) {
  const d = record.descriptor;
  const minerEntries = d.miners ? Object.values(d.miners) : [];
  const gpus = d.systemInfo?.gpus ?? [];
  // Report CPUs actually utilized by the miner (operator-signed
  // `miners.cpu.numCpus`), not host `systemInfo.cpu.logicalCores` —
  // logicalCores reflects the kernel's view of the container's host, which
  // overstates usage on bounded miners (e.g. num_cpus=1 on a 16-core box).
  const cpuMinerCpus = d.miners
    ? Object.values(d.miners).reduce(
        (sum, m) => (m.kind === "CPU" ? sum + (m.numCpus ?? 0) : sum),
        0,
      )
    : 0;
  const cpuLine = d.systemInfo?.cpu?.brand
    ? `${d.systemInfo.cpu.brand}${
        cpuMinerCpus > 0 ? ` (${cpuMinerCpus} CPU${cpuMinerCpus === 1 ? "" : "s"})` : ""
      }`
    : null;

  return (
    <div className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[1fr_2fr]">
      <div>
        <div className="font-heading text-base text-ink-strong">{d.nodeName}</div>
        <div className="mt-1 font-mono text-xs text-ink-subtle" title={record.accountId}>
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
            <span className="text-ink-subtle">CPU:</span>{" "}
            <span className="text-ink-strong">{cpuLine}</span>
          </div>
        )}
        {gpus.length > 0 && (
          <div>
            <span className="text-ink-subtle">
              GPU{gpus.length > 1 ? `s (${gpus.length})` : ""}:
            </span>{" "}
            <span className="text-ink-strong">
              {gpus.map((g) => g.name ?? "unknown").join(", ")}
            </span>
          </div>
        )}
        {minerEntries.length > 0 && (
          <div>
            <span className="text-ink-subtle">Miners:</span>{" "}
            <span className="text-ink-strong">
              {minerEntries.map((m) => `${m.kind}/${m.minerId}`).join(" · ")}
            </span>
          </div>
        )}
        {d.publicHost && (
          <div>
            <span className="text-ink-subtle">Reachable:</span>{" "}
            <span className="text-ink-strong">
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
      ? "bg-surface-2 text-ink-strong"
      : tone === "success"
        ? "bg-positive/20 text-positive"
        : "bg-surface-1 text-ink-subtle";
  return <span className={clsx("px-2 py-0.5", cls)}>{label}</span>;
}
