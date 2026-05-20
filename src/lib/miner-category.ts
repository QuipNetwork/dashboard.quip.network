// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChainMinerRecord, MinerCategory } from "../types/telemetry";

/**
 * Build a `minerId -> MinerCategory` lookup keyed by SS58 account id.
 *
 * v0.3 transitional state: `ChainMinerRecord` does not yet surface a joined
 * `primaryType`. The only hardware row populated server-side is `source='self'`,
 * which the SPA reads via `MyNodeView` (not here). For this lookup every chain
 * miner — and every unknown miner — degrades to "OTHER" until peer-query /
 * chain-surface hardware sources land in a future version.
 *
 * Callers should treat "OTHER" as the *uncategorized* bucket, not as a
 * declared hardware type.
 */
export function buildMinerCategoryIndex(
  chainMiners: readonly ChainMinerRecord[],
): Map<string, MinerCategory> {
  const idx = new Map<string, MinerCategory>();
  for (const m of chainMiners) {
    idx.set(m.accountId, "OTHER");
  }
  return idx;
}

/**
 * Resolve a `minerId` to its `MinerCategory`. Defaults to "OTHER" for miners
 * not represented in the index (see `buildMinerCategoryIndex`).
 */
export function categoryFor(
  minerId: string,
  index: ReadonlyMap<string, MinerCategory>,
): MinerCategory {
  return index.get(minerId) ?? "OTHER";
}
