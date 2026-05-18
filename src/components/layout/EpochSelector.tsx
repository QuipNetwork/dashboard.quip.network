// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { formatEpochId } from "../../lib/format";
import { buildEpochStatusMap, useTelemetryStore } from "../../store/telemetry-store";
import { useUIStore, type EpochFilter } from "../../store/ui-store";
import type { EpochStatus } from "../../types/telemetry";

interface EpochRow {
  id: string;
  firstBlockTimestamp: number | null;
  isLive: boolean;
  // Server-side tag from /api/telemetry/index. null when the indexer hasn't
  // catalogued this epoch yet (rare — possible mid-poll race for a freshly
  // discovered epoch). Treat null as "past canonical" — no badge.
  serverStatus: EpochStatus | null;
}

/**
 * Compose the trailing label for an epoch row. Audit fix #2: distinguish
 * the *live* epoch (currently extending), *stale_fork* epochs (chain
 * abandoned mid-way), and unlabeled past canonical epochs (just history).
 *
 * Previous behavior tagged every non-live epoch as "(stale)", which
 * conflated historical canonical epochs with actual stale forks. Operators
 * read those as "indexer is broken" and went hunting for a problem that
 * wasn't there.
 */
function composeBadge(row: EpochRow): string {
  if (row.isLive) return " (live)";
  if (row.serverStatus === "stale_fork") return " (stale fork)";
  return "";
}

export function EpochSelector() {
  const blocks = useTelemetryStore((s) => s.blocks);
  const liveEpoch = useTelemetryStore((s) => s.indexer?.nodeLatestEpoch ?? null);
  const telemetryIndex = useTelemetryStore((s) => s.telemetryIndex);
  // Memoize the status lookup. Returning a fresh Map from the selector
  // would trip Zustand's reference equality and cause render loops.
  const statusMap = useMemo(() => buildEpochStatusMap(telemetryIndex), [telemetryIndex]);
  const selectedEpoch = useUIStore((s) => s.selectedEpoch);
  const setSelectedEpoch = useUIStore((s) => s.setSelectedEpoch);

  // Derive the epoch list from the blocks we already have in memory — the
  // /api/telemetry response drives everything else. block_1 timestamps give
  // each option a readable time cue; `liveEpoch` tags the currently-
  // extending chain; the status map tags actual stale_fork epochs.
  //
  // Stale-fork epochs typically aren't in `blocks` (the server filters by
  // is_canonical=TRUE by default) — but their entries in `telemetryIndex`
  // still inform the badge if they happen to appear here.
  const epochs = useMemo<EpochRow[]>(() => {
    const firstBlockTs = new Map<string, number>();
    const seen = new Set<string>();
    for (const b of blocks) {
      seen.add(b.epoch);
      if (b.blockIndex === 1) firstBlockTs.set(b.epoch, b.timestamp);
    }
    const rows: EpochRow[] = [...seen].map((id) => ({
      id,
      firstBlockTimestamp: firstBlockTs.get(id) ?? null,
      isLive: liveEpoch !== null && id === liveEpoch,
      serverStatus: statusMap.get(id) ?? null,
    }));
    // Newest first by block_1 timestamp; epochs without block_1 (partial
    // backfills) sink to the bottom. Ties break on epoch hash for stability.
    rows.sort((a, b) => {
      const at = a.firstBlockTimestamp ?? -Infinity;
      const bt = b.firstBlockTimestamp ?? -Infinity;
      if (at !== bt) return bt - at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return rows;
  }, [blocks, liveEpoch, statusMap]);

  const onChange: React.ChangeEventHandler<HTMLSelectElement> = (e) => {
    const v = e.target.value;
    const next: EpochFilter = v === "all" ? "all" : v;
    setSelectedEpoch(next);
  };

  return (
    <label className="flex items-center gap-2 font-accent text-sm text-brand-gray-3">
      <span className="text-[10px] uppercase tracking-wider">Epoch</span>
      <select
        value={selectedEpoch}
        onChange={onChange}
        className="max-w-[14rem] cursor-pointer truncate rounded-lg border border-brand-gray-2 bg-brand-gray-1/50 px-2 py-1.5 font-accent text-sm text-brand-gray-5 outline-none transition-colors hover:border-brand-gray-3 focus:border-brand-gray-4"
      >
        <option value="all">All ({epochs.length})</option>
        {epochs.map((e) => (
          <option key={e.id} value={e.id}>
            {formatEpochId(e.id, e.firstBlockTimestamp)}
            {composeBadge(e)}
          </option>
        ))}
      </select>
    </label>
  );
}
