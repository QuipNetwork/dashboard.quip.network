// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { useTelemetryStore } from "../../store/telemetry-store";
import { useUIStore, type EpochFilter } from "../../store/ui-store";

export function EpochSelector() {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedEpoch = useUIStore((s) => s.selectedEpoch);
  const setSelectedEpoch = useUIStore((s) => s.setSelectedEpoch);

  // Derive the epoch list from the blocks we already have in memory — the
  // /api/telemetry response drives everything else, so using a separate
  // /api/telemetry/index call would desynchronize with the charts.
  const epochs = useMemo(() => {
    const set = new Set<number>();
    for (const b of blocks) set.add(b.epoch);
    return [...set].sort((a, b) => b - a); // newest first
  }, [blocks]);

  const onChange: React.ChangeEventHandler<HTMLSelectElement> = (e) => {
    const v = e.target.value;
    const next: EpochFilter = v === "all" ? "all" : Number(v);
    setSelectedEpoch(next);
  };

  return (
    <label className="flex items-center gap-2 font-accent text-sm text-brand-gray-3">
      <span className="text-[10px] uppercase tracking-wider">Epoch</span>
      <select
        value={selectedEpoch === "all" ? "all" : String(selectedEpoch)}
        onChange={onChange}
        className="cursor-pointer rounded-lg border border-brand-gray-2 bg-brand-gray-1/50 px-2 py-1.5 font-accent text-sm text-brand-gray-5 outline-none transition-colors hover:border-brand-gray-3 focus:border-brand-gray-4"
      >
        <option value="all">All ({epochs.length})</option>
        {epochs.map((e) => (
          <option key={e} value={String(e)}>
            {formatEpoch(e)}
          </option>
        ))}
      </select>
    </label>
  );
}

// Epoch numbers in this network are unix timestamps. Render them as a short
// date so the dropdown reads naturally ("Apr 21 18:53") instead of as a raw
// 10-digit integer.
function formatEpoch(e: number): string {
  // Heuristic: values >1e9 are second-precision timestamps (year ~2001+),
  // anything smaller is just the raw integer epoch.
  if (e >= 1_000_000_000) {
    const d = new Date(e * 1000);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }
  return String(e);
}
