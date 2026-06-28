// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ChainMinerRecord,
  MinerCategory,
  NodeDescriptorRecord,
  NodeMinerEntry,
} from "../types/telemetry";

/**
 * Build a `minerId -> MinerCategory` lookup keyed by SS58 account id.
 *
 * Resolution order (first hit wins):
 *   1. `m.hardware.primaryType` — populated by tip-worker for `source='self'`.
 *   2. Derived from chain-signed `nodeDescriptors[].descriptor.miners[].kind`
 *      — operator-asserted but covers every account that ran
 *      `quip-miner identify`.
 *   3. "OTHER" — uncategorized fallback for accounts with no hardware data.
 *
 * Callers should treat "OTHER" as the *uncategorized* bucket, not as a
 * declared hardware type.
 */
export function buildMinerCategoryIndex(
  chainMiners: readonly ChainMinerRecord[],
  nodeDescriptors: readonly NodeDescriptorRecord[] = [],
): Map<string, MinerCategory> {
  const descriptorByAccount = new Map<string, MinerCategory>();
  for (const d of nodeDescriptors) {
    const derived = derivePrimaryTypeFromDescriptor(d.descriptor.miners);
    if (derived !== null) descriptorByAccount.set(d.accountId, derived);
  }
  const idx = new Map<string, MinerCategory>();
  for (const m of chainMiners) {
    const direct = m.hardware?.primaryType;
    if (direct) {
      idx.set(m.accountId, direct);
      continue;
    }
    const fromDescriptor = descriptorByAccount.get(m.accountId);
    idx.set(m.accountId, fromDescriptor ?? "OTHER");
  }
  // Accounts with a descriptor but no chain_miners row still belong in the
  // index — block authors who haven't earned a chain reward yet would
  // otherwise vanish into "OTHER" when the lookup misses entirely.
  for (const [account, cat] of descriptorByAccount) {
    if (!idx.has(account)) idx.set(account, cat);
  }
  return idx;
}

/**
 * Pick the dominant `MinerCategory` for a descriptor's `miners` list. Ties
 * resolve toward the higher-yield hardware (GPU > QPU > CPU > OTHER) so a
 * heterogeneous rig shows up under its most computationally-significant
 * device. Returns null for an empty/undefined list so the caller can fall
 * through to the next resolution step.
 */
function derivePrimaryTypeFromDescriptor(
  miners: NodeMinerEntry[] | undefined,
): MinerCategory | null {
  if (!miners || miners.length === 0) return null;
  const counts: Record<MinerCategory, number> = { CPU: 0, GPU: 0, QPU: 0, OTHER: 0 };
  for (const m of miners) {
    counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  }
  // Tie-break order — GPU first since it's the highest-throughput in this
  // project's typical fleet, then QPU, then CPU, then OTHER.
  const priority: MinerCategory[] = ["GPU", "QPU", "CPU", "OTHER"];
  let best: MinerCategory = "OTHER";
  let bestCount = -1;
  for (const cat of priority) {
    if (counts[cat] > bestCount) {
      best = cat;
      bestCount = counts[cat];
    }
  }
  return best;
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
