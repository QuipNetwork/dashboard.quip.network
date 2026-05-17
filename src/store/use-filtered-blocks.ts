// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { useTelemetryStore } from "./telemetry-store";
import { useUIStore } from "./ui-store";
import type { BlockRecord } from "../types/telemetry";

/**
 * Returns the blocks array filtered by the current `selectedEpoch`. When
 * `selectedEpoch === "all"` this is the raw array (no copy). Every chart hook
 * funnels its block input through here so a single control in the header
 * scopes the entire dashboard.
 *
 * **Canonical-only invariant (audit fix #4).** `useTelemetryStore.blocks`
 * comes from `/api/telemetry`, which the server canonical-filters via
 * `db.getAllBlocks()` (returns only `is_canonical = TRUE` rows). Dead-fork
 * blocks never reach the SPA. Chart hooks that build on top of this hook
 * therefore can't accidentally rank/aggregate dead-fork data — the
 * `blocks` reference identity changes on every poll, so the `useMemo`
 * cache keyed on `[blocks, ...]` invalidates correctly when an epoch
 * flips canonical-status server-side.
 *
 * If a future view needs to surface stale-fork blocks (e.g. a forensics
 * pane), add a dedicated server endpoint that opts out of the filter
 * rather than threading a `allowStaleForks` parameter through this hook —
 * mixing canonical and dead-fork data inside the same selector ruins the
 * invariant for every downstream chart.
 */
export function useFilteredBlocks(): BlockRecord[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedEpoch = useUIStore((s) => s.selectedEpoch);

  return useMemo(() => {
    if (selectedEpoch === "all") return blocks;
    return blocks.filter((b) => b.epoch === selectedEpoch);
  }, [blocks, selectedEpoch]);
}
