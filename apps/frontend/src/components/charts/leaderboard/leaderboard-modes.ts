// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mode-aware ranking for the Mining Leaderboard: "By Count" is the existing
// chain-authoritative `proofs_won` ranking (computeLeaderboard, unchanged);
// "By Energy"/"By Time" re-rank the same entries by sums over the indexed
// `blocks` window, using resolveDeviceAccessTime (lib/device-access-time.ts)
// and hardware-power.ts for the per-win estimates being summed. Both new
// modes are inherently indexed-window totals, never lifetime figures — the
// card's subtitle must disclose that (wu14-brief.md R3); this module never
// tries to extrapolate a lifetime number from a partial window.

import { resolveDeviceAccessTime } from "@/lib/device-access-time";
import { estimateDeviceWatts, estimateEnergyJoules } from "@/lib/hardware-power";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import type {
  BlockRecord,
  ChainMinerRecord,
  NodeDescriptorRecord,
  NodesSnapshot,
} from "@quip/shared/telemetry";
import type { LeaderboardEntry } from "./use-leaderboard";

export type LeaderboardMode = "byCount" | "byEnergy" | "byTime";

export const LEADERBOARD_MODES: ReadonlyArray<{ value: LeaderboardMode; label: string }> = [
  { value: "byCount", label: "By Count" },
  { value: "byEnergy", label: "By Energy" },
  { value: "byTime", label: "By Time" },
];

export interface MinerTimeEnergyTotals {
  totalSeconds: number;
  totalJoules: number;
  // True when at least one contributing win's device-access time was
  // estimated rather than self-reported — see resolveDeviceAccessTime.
  estimated: boolean;
}

/**
 * Sum per-miner device-access time and energy across the indexed `blocks`
 * window — one block is one win, so every block contributes exactly one
 * term. `nodes` resolves a miner's own hardware for the wattage estimate via
 * `ChainMinerRecord.telemetryNodeAddress`; miners with no joined node fall
 * back to `estimateDeviceWatts`'s category default.
 */
export function computeMinerTimeEnergyTotals(
  blocks: readonly BlockRecord[],
  chainMiners: readonly ChainMinerRecord[],
  nodeDescriptors: readonly NodeDescriptorRecord[] = [],
  nodes: NodesSnapshot | null = null,
): Map<string, MinerTimeEnergyTotals> {
  const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
  const nodeByAccount = new Map(
    chainMiners
      .filter((m) => m.telemetryNodeAddress != null)
      .map((m) => [m.accountId, nodes?.nodes[m.telemetryNodeAddress as string]]),
  );

  const totals = new Map<string, MinerTimeEnergyTotals>();
  for (const block of blocks) {
    const category = categoryFor(block.minerId, catIndex);
    const { seconds, estimated } = resolveDeviceAccessTime(block, category);
    const watts = estimateDeviceWatts(category, nodeByAccount.get(block.minerId));
    const joules = estimateEnergyJoules(watts, seconds);
    const prev = totals.get(block.minerId);
    totals.set(block.minerId, {
      totalSeconds: (prev?.totalSeconds ?? 0) + seconds,
      totalJoules: (prev?.totalJoules ?? 0) + joules,
      estimated: (prev?.estimated ?? false) || estimated,
    });
  }
  return totals;
}

/** Merge `computeMinerTimeEnergyTotals` output onto leaderboard entries. */
export function withTimeEnergyTotals(
  entries: readonly LeaderboardEntry[],
  totals: ReadonlyMap<string, MinerTimeEnergyTotals>,
): LeaderboardEntry[] {
  return entries.map((e) => {
    const t = totals.get(e.minerId);
    return {
      ...e,
      totalMiningSeconds: t?.totalSeconds ?? null,
      totalEnergyJoules: t?.totalJoules ?? null,
      estimated: t?.estimated ?? false,
    };
  });
}

// Only meaningful for byTime/byEnergy — applyLeaderboardMode returns early
// for byCount, so this never needs to report blockCount.
function metricFor(entry: LeaderboardEntry, mode: LeaderboardMode): number | null {
  if (mode === "byTime") return entry.totalMiningSeconds ?? null;
  return entry.totalEnergyJoules ?? null;
}

/**
 * Re-rank/re-share entries by the active mode's metric. "By Count" passes
 * entries through unchanged — their rank/share already come from
 * `computeLeaderboard`'s chain-authoritative `proofs_won` figures (higher
 * wins is better there). "By Time"/"By Energy" re-derive rank and share from
 * the indexed-window totals (see `withTimeEnergyTotals`) and sort ASCENDING
 * — least energy/time is the best rank (1st), the inverse of "By Count".
 * A miner with no indexed wins contributes 0 to `share` (never NaN) but
 * always ranks last: "no data" must never look like "the best score".
 */
export function applyLeaderboardMode(
  entries: readonly LeaderboardEntry[],
  mode: LeaderboardMode,
): LeaderboardEntry[] {
  if (mode === "byCount") return [...entries];
  const total = entries.reduce((sum, e) => sum + (metricFor(e, mode) ?? 0), 0);
  return [...entries]
    .sort((a, b) => {
      const av = metricFor(a, mode);
      const bv = metricFor(b, mode);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    })
    .map((e, i) => ({
      ...e,
      rank: i + 1,
      share: total > 0 ? (metricFor(e, mode) ?? 0) / total : 0,
    }));
}

// J → kJ → kWh scaling, mirroring formatDuration's "never show three units"
// idiom (lib/format.ts). A single QPU win alone (12 kW × ~62ms) lands around
// 744 J, so kJ covers the CPU/GPU per-win range while kWh keeps the eventual
// large totals (many wins, or QPU's constant 12kW draw) in familiar units.
export function formatEnergyJoules(joules: number): string {
  if (!Number.isFinite(joules)) return "—";
  const abs = Math.abs(joules);
  if (abs < 1_000) return `${joules.toFixed(0)} J`;
  if (abs < 1_000_000) return `${(joules / 1_000).toFixed(2)} kJ`;
  return `${(joules / 3_600_000).toFixed(2)} kWh`;
}
