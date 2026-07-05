// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ChainMinerRecord,
  MinerCategory,
  NodeDescriptorRecord,
  NodeMinerEntry,
} from "@quip/shared/telemetry";

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
 * Pick the `MinerCategory` for a descriptor's `miners` map by hardware
 * *capability* (GPU > QPU > CPU > OTHER), not process count: a heterogeneous
 * rig shows up under its most computationally-significant device, so a box
 * running many CPU workers alongside one GPU miner is a GPU node. Matches the
 * indexer's self-status `derivePrimaryType` so both resolution paths agree.
 * Returns null for an empty/undefined map so the caller can fall through to
 * the next resolution step.
 */
function derivePrimaryTypeFromDescriptor(
  miners: Record<string, NodeMinerEntry> | undefined,
): MinerCategory | null {
  if (!miners) return null;
  const present = new Set(Object.values(miners).map((m) => m.kind));
  if (present.size === 0) return null;
  for (const cat of ["GPU", "QPU", "CPU"] as const) {
    if (present.has(cat)) return cat;
  }
  return "OTHER";
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
