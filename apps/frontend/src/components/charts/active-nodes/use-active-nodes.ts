// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { minerKindToCategory } from "@quip/shared/telemetry";
import type { MinerCategory, ParticipationComputeRow } from "@quip/shared/telemetry";

export interface ActiveNodesEntry {
  [key: string]: string | number;
  minerType: MinerCategory;
  count: number;
}

/**
 * Distinct miners per category across the qblock participation window (every
 * node that raced a qblock, not only the winners of the recent blocks).
 */
export function useActiveNodes(): ActiveNodesEntry[] {
  const participationCompute = useTelemetryStore((s) => s.participationCompute);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const counts = countMinersByCategory(participationCompute, catIndex);
    // Emit every selected bucket so zero-count categories still render.
    return selectedTypes.map((type) => ({
      minerType: type,
      count: counts.get(type) ?? 0,
    }));
  }, [participationCompute, chainMiners, nodeDescriptors, selectedTypes]);
}

/**
 * Count distinct participating accounts per category.
 *
 * `rows` holds one entry per (qblock, account) with the on-chain `kind` that
 * account declared for that qblock (`minerKindToCategory(row.kind)` maps it).
 * `catIndex` maps an account to its single primary category from chain
 * hardware or its node descriptor (GPU > QPU > CPU > OTHER).
 */
export function countMinersByCategory(
  rows: readonly ParticipationComputeRow[],
  catIndex: ReadonlyMap<string, MinerCategory>,
): Map<MinerCategory, number> {
  // Like the winner-based count this replaces, an account counts once, under
  // its primary category; its declared kind covers accounts the index lacks.
  const categoryByAccount = new Map<string, MinerCategory>();
  for (const r of rows) {
    if (categoryByAccount.has(r.account)) continue;
    categoryByAccount.set(r.account, catIndex.get(r.account) ?? minerKindToCategory(r.kind));
  }
  const counts = new Map<MinerCategory, number>();
  for (const category of categoryByAccount.values()) {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return counts;
}
