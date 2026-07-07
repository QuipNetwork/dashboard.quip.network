// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bucket math for the per-type Energy Distribution mini-histograms (WU10,
// nextsteps.md #6b/#6c). Pure data-in/data-out: no React, no stores.
//
// ## Sign convention ("which end is hardest")
//
// `energy` is negative, and MORE NEGATIVE = HARDER — established elsewhere in
// the codebase: `DIFFICULTY_DATA_FLOOR_ENERGY` (lib/difficulty-curve.ts)
// keeps targets with `difficultyEnergy <= FLOOR`, i.e. the *more negative*
// ("harder") ones, and a win only counts when its achieved `energy` is at or
// below (more negative than) its target. So the hardest win ever mined is
// simply `Math.min(energies)`.
//
// The by-difficulty *line* charts (win-rate, mining-time-by-difficulty) flip
// display via `xScale.reverse` so that minimum lands on the visual right.
// These mini-histograms don't need that: ascending numeric order already
// puts the hardest value first, so rendering buckets in plain ascending
// order makes the hardest bucket the leftmost one — and the literal "< E"
// label on it reads correctly (harder = a smaller/more-negative number) with
// no sign flip required.
//
// ## Bucket layout
//
// Buckets are `ENERGY_BUCKET_WIDTH` energy units wide. One edge is anchored
// exactly at the hardest energy ever mined: the leftmost bucket is left-open
// (no lower bound), so it contains that win and — without needing to
// recompute edges — any future win harder still. Successive buckets extend
// rightward (easier) in fixed steps; the last one is right-open, absorbing
// any win easier than the generated range fits.

import { formatEnergy } from "@/lib/format-chain";

export const ENERGY_BUCKET_WIDTH = 20;

// Total buckets per mini-histogram, including both open ends. Small enough
// to stay readable in a card-height mini panel (see EnergyDistributionCard).
export const ENERGY_BUCKET_COUNT = 6;

export interface EnergyBucket {
  lo: number; // inclusive lower bound; -Infinity for the leftmost (hardest) bucket
  hi: number; // exclusive upper bound; +Infinity for the rightmost (easiest) bucket
  label: string;
}

/**
 * Build the shared bucket grid for a domain anchored at `hardestEnergy`. All
 * three per-type histograms bucket against the SAME grid so they stay
 * visually comparable — only each type's percentages differ.
 */
export function buildEnergyBuckets(
  hardestEnergy: number,
  count: number = ENERGY_BUCKET_COUNT,
): EnergyBucket[] {
  const anchorHi = hardestEnergy + ENERGY_BUCKET_WIDTH;
  const buckets: EnergyBucket[] = [
    { lo: -Infinity, hi: anchorHi, label: `< ${formatEnergy(anchorHi)}` },
  ];
  for (let i = 1; i < count; i++) {
    const lo = anchorHi + (i - 1) * ENERGY_BUCKET_WIDTH;
    const hi = i === count - 1 ? Infinity : lo + ENERGY_BUCKET_WIDTH;
    buckets.push({ lo, hi, label: formatEnergy(lo) });
  }
  return buckets;
}

/** Index of the bucket containing `value`, per {@link buildEnergyBuckets}'s ascending grid. */
export function bucketIndexFor(buckets: readonly EnergyBucket[], value: number): number {
  for (let i = 0; i < buckets.length; i++) {
    if (value < buckets[i]!.hi) return i;
  }
  return buckets.length - 1;
}
