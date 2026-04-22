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
 */
export function useFilteredBlocks(): BlockRecord[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedEpoch = useUIStore((s) => s.selectedEpoch);

  return useMemo(() => {
    if (selectedEpoch === "all") return blocks;
    return blocks.filter((b) => b.epoch === selectedEpoch);
  }, [blocks, selectedEpoch]);
}
