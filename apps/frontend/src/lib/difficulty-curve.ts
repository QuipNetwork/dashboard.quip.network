// SPDX-License-Identifier: AGPL-3.0-or-later
// energy (units, negative) -> ratio along the chain's linear energy curve:
// c = -energy / K. Null when K is unknown (pre-v0.2 / no default topology),
// so callers fall back to showing raw energy.

import { useTelemetryStore } from "@/store/telemetry-store";

// The by-difficulty charts (mining time, win rate) only have meaningful data
// once targets reach the hard regime. Easier "warmup" targets that kick off
// mining arrive in bulk while difficulty ramps up, so they survive IQR outlier
// removal and stretch the axis into a long, sparse, misleading tail. Clip the
// easy end of those charts here so the axis starts where real data is. Tunable.
export const DIFFICULTY_DATA_FLOOR_ENERGY = -14_000;

/**
 * Drop blocks whose target is easier (less negative) than the data floor, so
 * the difficulty axis starts where meaningful data exists. Returns the input
 * unchanged when nothing reaches the floor, so a fresh/easy chain still renders
 * whatever data it has instead of an empty chart.
 */
export function clipToDifficultyFloor<T extends { difficultyEnergy: number }>(blocks: T[]): T[] {
  const hard = blocks.filter((b) => b.difficultyEnergy <= DIFFICULTY_DATA_FLOOR_ENERGY);
  return hard.length > 0 ? hard : blocks;
}

// The curve ratio c = -E/K: how far along the curve constant K a target
// energy sits. A plain fraction, NOT a probability — display it as e.g.
// "0.746", never with a %/‰ suffix.
export function energyToCurveRatio(energy: number, k: number | null): number | null {
  if (k == null || !(k > 0)) return null;
  return -energy / k;
}

// Tick label: "0.747 (−14559)" when K is known, else "−14559". Energies are
// large integers (units), so no decimal place. Too wide to sit flat on an
// axis — charts rotate their bottom ticks instead of shortening the label.
export function formatDifficultyTick(energy: number, k: number | null): string {
  const e = String(Math.round(energy));
  const c = energyToCurveRatio(energy, k);
  return c == null ? e : `${c.toFixed(3)} (${e})`;
}

/**
 * The difficulty-curve constant K of the current default topology, or null
 * when the chain hasn't exposed it (pre-v0.2 / no default topology yet).
 * Charts pass this to {@link formatDifficultyTick} so a missing K degrades to
 * showing the raw energy instead of a curve ratio.
 */
export function useDifficultyCurveK(): number | null {
  return (
    useTelemetryStore((s) => s.mineableTopologies).find((t) => t.isDefault)?.curveConstant ?? null
  );
}
