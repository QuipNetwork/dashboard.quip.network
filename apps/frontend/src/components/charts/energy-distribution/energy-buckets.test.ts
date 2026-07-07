// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bucket math for WU10's per-type mini-histograms. See energy-buckets.ts for
// the sign-convention writeup (more negative energy = harder; ascending
// numeric order already puts the hardest value first).

import { describe, expect, test } from "bun:test";
import {
  bucketIndexFor,
  buildEnergyBuckets,
  ENERGY_BUCKET_WIDTH,
  type EnergyBucket,
} from "./energy-buckets";

describe("buildEnergyBuckets", () => {
  test("every regular (non-open-ended) bucket is exactly 20 energy units wide", () => {
    const buckets = buildEnergyBuckets(-15_620);
    for (const b of buckets) {
      if (!Number.isFinite(b.lo) || !Number.isFinite(b.hi)) continue;
      expect(b.hi - b.lo).toBe(ENERGY_BUCKET_WIDTH);
    }
  });

  test("the leftmost bucket is anchored at the hardest value and is left-open", () => {
    const hardest = -15_620;
    const buckets = buildEnergyBuckets(hardest);
    expect(buckets[0]!.lo).toBe(-Infinity);
    // Anchored exactly 20 units above the hardest value, not floating.
    expect(buckets[0]!.hi).toBe(hardest + ENERGY_BUCKET_WIDTH);
    // The hardest win itself falls inside it.
    expect(hardest).toBeLessThan(buckets[0]!.hi);
  });

  test("the leftmost bucket is labeled with a literal '<' — ascending order means", () => {
    // more-negative (harder) sorts first, so "< boundary" reads correctly
    // without a sign flip (see energy-buckets.ts header comment).
    const buckets = buildEnergyBuckets(-15_620);
    expect(buckets[0]!.label).toBe("< -15600");
  });

  test("the rightmost bucket is right-open, absorbing any easier straggler", () => {
    const buckets = buildEnergyBuckets(-15_620, 5);
    expect(buckets.at(-1)!.hi).toBe(Infinity);
  });

  test("buckets ascend in fixed 20-unit steps between the two open ends", () => {
    const buckets = buildEnergyBuckets(-15_620, 6);
    expect(buckets.map((b) => b.lo)).toEqual([
      -Infinity,
      -15_600,
      -15_580,
      -15_560,
      -15_540,
      -15_520,
    ]);
  });

  test("respects the requested bucket count", () => {
    expect(buildEnergyBuckets(-15_620, 4)).toHaveLength(4);
    expect(buildEnergyBuckets(-15_620, 8)).toHaveLength(8);
  });
});

describe("bucketIndexFor", () => {
  const buckets: EnergyBucket[] = buildEnergyBuckets(-15_620, 5);

  test("the hardest value lands in the leftmost (open) bucket", () => {
    expect(bucketIndexFor(buckets, -15_620)).toBe(0);
  });

  test("a value harder than any observed win still lands in the leftmost bucket", () => {
    expect(bucketIndexFor(buckets, -99_999)).toBe(0);
  });

  test("values walk rightward through regular buckets in order", () => {
    expect(bucketIndexFor(buckets, -15_599)).toBe(1); // [-15600, -15580)
    expect(bucketIndexFor(buckets, -15_580)).toBe(2); // [-15580, -15560)
  });

  test("a value far easier than the generated range lands in the rightmost (open) bucket", () => {
    expect(bucketIndexFor(buckets, 0)).toBe(buckets.length - 1);
  });
});
