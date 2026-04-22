// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { formatEpochTimestamp } from "../../lib/format";
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
            {formatEpochTimestamp(e)}
          </option>
        ))}
      </select>
    </label>
  );
}
