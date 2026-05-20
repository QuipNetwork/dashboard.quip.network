// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { useTelemetryStore } from "./telemetry-store";
import { useUIStore } from "./ui-store";
import type { BlockRecord, MinerCategory } from "../types/telemetry";

/**
 * Returns the blocks array filtered by the active miner-category selection.
 *
 * v0.3 dropped the epoch dimension — the chain is the canonical source and
 * blocks no longer carry an `epoch` field. The only remaining filter is
 * `selectedTypes` on the UI store, which joins each block's `minerId`
 * against `chainMiners` to recover the miner's `primaryType`.
 *
 * **Hardware data is sparse today.** `miner_hardware` only has a row for
 * `self` (see `MinerHardwareRecord.source = "self"`). The `ChainMinerRecord`
 * shape doesn't surface `primaryType` yet — the proper server-side join
 * lands when peer-query / chain-surface hardware sources are implemented
 * (future v0.4+). Until then every chain miner degrades to "OTHER" and
 * blocks whose `minerId` isn't in `chainMiners` also fall back to "OTHER".
 * With the default `selectedTypes = ["CPU","GPU","QPU"]` this hides all
 * blocks when the type filter is active; consumers (charts, MyNode view)
 * are being reshaped in tandem (tasks 3.4–3.7).
 *
 * **Canonical-only invariant (audit fix #4).** `useTelemetryStore.blocks`
 * comes from `/api/telemetry`, which the server canonical-filters via
 * `db.getAllBlocks()` (returns only `is_canonical = TRUE` rows). Dead-fork
 * blocks never reach the SPA. Chart hooks built on top of this hook
 * therefore can't accidentally rank/aggregate dead-fork data — the
 * `blocks` reference identity changes on every poll, so the `useMemo`
 * cache keyed on `[blocks, chainMiners, selectedTypes]` invalidates
 * correctly.
 */
export function useFilteredBlocks(): BlockRecord[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    if (selectedTypes.length === 0) return blocks; // no filter active
    // Build accountId → primaryType lookup from chain miners. Until
    // ChainMinerRecord surfaces a joined primaryType (deferred — see
    // header comment), every entry resolves to "OTHER".
    const typeByAccount = new Map<string, MinerCategory>();
    for (const m of chainMiners) {
      typeByAccount.set(m.accountId, "OTHER");
    }
    const allowed = new Set(selectedTypes);
    return blocks.filter((b) => allowed.has(typeByAccount.get(b.minerId) ?? "OTHER"));
  }, [blocks, chainMiners, selectedTypes]);
}
