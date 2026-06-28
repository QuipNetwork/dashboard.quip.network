// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "./telemetry-store";
import { useUIStore } from "./ui-store";
import type { BlockRecord } from "@quip/shared/telemetry";

/**
 * Returns the blocks array filtered by the active miner-category selection.
 *
 * Resolution chain (mirrors `buildMinerCategoryIndex`):
 *   1. `chainMiners[].hardware.primaryType` — populated for `source='self'`.
 *   2. Derived from chain-signed `nodeDescriptors[].descriptor.miners[].kind`
 *      — covers every operator that has run `quip-miner identify`.
 *   3. "OTHER" — uncategorized.
 *
 * With the default `selectedTypes = ["CPU","GPU","QPU"]`, accounts that
 * still resolve to "OTHER" (no descriptor, no self-hardware) are hidden.
 * That used to mean *all* miners — until descriptors landed in v11 — so
 * the chart suite would render empty against a chain whose miners had
 * never published an identify extrinsic.
 *
 * **Canonical-only invariant.** `useTelemetryStore.blocks` comes from
 * `/api/telemetry`, which serves only finalized substrate blocks. Dead-
 * fork blocks never reach the SPA.
 */
export function useFilteredBlocks(): BlockRecord[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    if (selectedTypes.length === 0) return blocks; // no filter active
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const allowed = new Set(selectedTypes);
    return blocks.filter((b) => allowed.has(categoryFor(b.minerId, catIndex)));
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes]);
}
