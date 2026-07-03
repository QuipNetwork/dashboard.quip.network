// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Property tests for the pure coverage interval algebra (spec §7).
// The model: a coverage value is the covered set [low, high] \ gaps plus a
// prunedFloor; folds must keep it equal to a naive Set<number> model and the
// solver must partition [effectiveStart, head] into covered ∪ uncovered.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  coverRange,
  emptyCoverage,
  isComplete,
  parseCoverage,
  raisePrunedFloor,
  reprobePrunedFloor,
  serializeCoverage,
  uncovered,
  type Coverage,
} from "./coverage";

// Reconstruct the covered set from the compact representation.
function coveredSet(cov: Coverage): Set<number> {
  const out = new Set<number>();
  if (cov.low === null || cov.high === null) return out;
  for (let n = cov.low; n <= cov.high; n++) out.add(n);
  for (const [a, b] of cov.gaps) for (let n = a; n <= b; n++) out.delete(n);
  return out;
}

// Structural invariants from spec §7.
function assertInvariants(cov: Coverage): void {
  expect(cov.v).toBe(1);
  if (cov.low === null || cov.high === null) {
    expect(cov.low).toBeNull();
    expect(cov.high).toBeNull();
    expect(cov.gaps).toEqual([]);
    return;
  }
  expect(cov.low).toBeLessThanOrEqual(cov.high);
  // low and high themselves are always covered (gaps are strictly inside).
  let prevEnd = -Infinity;
  for (const [a, b] of cov.gaps) {
    expect(a).toBeLessThanOrEqual(b);
    expect(a).toBeGreaterThan(cov.low);
    expect(b).toBeLessThan(cov.high);
    // sorted, disjoint, non-adjacent (adjacent gaps must merge)
    expect(a).toBeGreaterThan(prevEnd + 1);
    prevEnd = b;
  }
}

// Small universes keep Set models cheap while still exploring the algebra.
const arbRange = fc
  .tuple(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 120 }))
  .map(([x, y]) => (x <= y ? ([x, y] as const) : ([y, x] as const)));

describe("coverage algebra — model equivalence", () => {
  test("folding random ranges matches a Set model and keeps invariants", () => {
    fc.assert(
      fc.property(fc.array(arbRange, { maxLength: 25 }), (ranges) => {
        let cov = emptyCoverage(1, 0);
        const model = new Set<number>();
        for (const [a, b] of ranges) {
          cov = coverRange(cov, a, b);
          for (let n = a; n <= b; n++) model.add(n);
          assertInvariants(cov);
          expect(coveredSet(cov)).toEqual(model);
        }
      }),
    );
  });

  test("covered set only grows (monotone under any fold sequence)", () => {
    fc.assert(
      fc.property(fc.array(arbRange, { minLength: 1, maxLength: 25 }), (ranges) => {
        let cov = emptyCoverage(1, 0);
        let prev = new Set<number>();
        for (const [a, b] of ranges) {
          cov = coverRange(cov, a, b);
          const now = coveredSet(cov);
          for (const n of prev) expect(now.has(n)).toBe(true);
          prev = now;
        }
      }),
    );
  });
});

describe("coverage solver — uncovered()", () => {
  test("covered ∪ uncovered partitions [effectiveStart, head]", () => {
    fc.assert(
      fc.property(
        fc.array(arbRange, { maxLength: 15 }),
        fc.integer({ min: 0, max: 140 }),
        fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
        (ranges, head, floor) => {
          let cov = emptyCoverage(1, 0);
          for (const [a, b] of ranges) cov = coverRange(cov, a, b);
          if (floor !== null) cov = raisePrunedFloor(cov, floor);

          const covered = coveredSet(cov);
          const holes = uncovered(cov, head);
          const holeSet = new Set<number>();
          for (const [a, b] of holes) for (let n = a; n <= b; n++) holeSet.add(n);

          const effStart = cov.prunedFloor === null ? cov.start : cov.prunedFloor + 1;
          for (let n = effStart; n <= head; n++) {
            // every block in scope is exactly one of covered / uncovered
            expect(covered.has(n) !== holeSet.has(n)).toBe(true);
          }
          // solver never asks for work outside [effectiveStart, head]
          for (const n of holeSet) {
            expect(n).toBeGreaterThanOrEqual(effStart);
            expect(n).toBeLessThanOrEqual(head);
          }
        },
      ),
    );
  });

  test("isComplete(head) iff uncovered(head) is empty", () => {
    fc.assert(
      fc.property(
        fc.array(arbRange, { maxLength: 10 }),
        fc.integer({ min: 0, max: 140 }),
        (ranges, head) => {
          let cov = emptyCoverage(1, 0);
          for (const [a, b] of ranges) cov = coverRange(cov, a, b);
          expect(isComplete(cov, head)).toBe(uncovered(cov, head).length === 0);
        },
      ),
    );
  });
});

describe("winner-domain convergence (spec §7 property)", () => {
  test("winner items + per-chunk range completions converge to [start, head]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 40, max: 200 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { maxLength: 30 }),
        fc.integer({ min: 1, max: 64 }),
        (start, head, winnersRaw, chunkSize) => {
          const winners = winnersRaw.filter((w) => w >= start && w <= head);
          let cov = emptyCoverage(1, start);

          // Simulate the walker: chunk [start, head]; per chunk, complete the
          // winner items (item folds), then fold the range completion.
          for (let a = start; a <= head; a += chunkSize) {
            const b = Math.min(a + chunkSize - 1, head);
            for (const w of winners) if (w >= a && w <= b) cov = coverRange(cov, w, w);
            cov = coverRange(cov, a, b); // range-completion record
            assertInvariants(cov);
          }

          expect(isComplete(cov, head)).toBe(true);
          expect(uncovered(cov, head)).toEqual([]);
        },
      ),
    );
  });
});

describe("prunedFloor", () => {
  test("raisePrunedFloor is a ratchet (never lowers)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 12 }),
        (floors) => {
          let cov = emptyCoverage(1, 0);
          let best = -Infinity;
          for (const f of floors) {
            cov = raisePrunedFloor(cov, f);
            best = Math.max(best, f);
            expect(cov.prunedFloor).toBe(best);
          }
        },
      ),
    );
  });

  test("reprobePrunedFloor may lower or clear the floor (archive rotation)", () => {
    let cov = raisePrunedFloor(emptyCoverage(1, 0), 50);
    expect(cov.prunedFloor).toBe(50);
    cov = reprobePrunedFloor(cov, 10);
    expect(cov.prunedFloor).toBe(10);
    cov = reprobePrunedFloor(cov, null);
    expect(cov.prunedFloor).toBeNull();
  });

  test("uncovered never demands blocks at or below the floor", () => {
    let cov = emptyCoverage(1, 0);
    cov = raisePrunedFloor(cov, 40);
    const holes = uncovered(cov, 100);
    for (const [a] of holes) expect(a).toBeGreaterThan(40);
  });
});

describe("serialization", () => {
  test("serialize → parse round-trips every generated value", () => {
    fc.assert(
      fc.property(fc.array(arbRange, { maxLength: 10 }), (ranges) => {
        let cov = emptyCoverage(3, 7);
        for (const [a, b] of ranges) cov = coverRange(cov, a, b);
        const parsed = parseCoverage(
          JSON.parse(serializeCoverage(cov, "2026-07-02T00:00:00.000Z")),
        );
        expect(parsed).not.toBeNull();
        expect(coveredSet(parsed!)).toEqual(coveredSet(cov));
        expect(parsed!.gen).toBe(3);
        expect(parsed!.start).toBe(7);
      }),
    );
  });

  test("parse rejects garbage, wrong version, and malformed gaps", () => {
    expect(parseCoverage(null)).toBeNull();
    expect(parseCoverage("nope")).toBeNull();
    expect(parseCoverage({ v: 2, gen: 1, start: 0, low: null, high: null, gaps: [] })).toBeNull();
    expect(
      parseCoverage({ v: 1, gen: 1, start: 0, low: 5, high: 3, gaps: [], prunedFloor: null }),
    ).toBeNull();
    expect(
      parseCoverage({
        v: 1,
        gen: 1,
        start: 0,
        low: 0,
        high: 10,
        gaps: [[12, 14]],
        prunedFloor: null,
      }),
    ).toBeNull();
  });
});

describe("edge cases", () => {
  test("empty coverage: nothing covered, everything uncovered", () => {
    const cov = emptyCoverage(1, 5);
    expect(coveredSet(cov).size).toBe(0);
    expect(uncovered(cov, 9)).toEqual([[5, 9]]);
    expect(isComplete(cov, 9)).toBe(false);
  });

  test("head below start: nothing to do", () => {
    const cov = emptyCoverage(1, 100);
    expect(uncovered(cov, 50)).toEqual([]);
    expect(isComplete(cov, 50)).toBe(true);
  });

  test("out-of-order completion opens then closes a gap", () => {
    let cov = emptyCoverage(1, 0);
    cov = coverRange(cov, 10, 10);
    cov = coverRange(cov, 7, 7); // skips 8-9 → gap
    expect(cov.gaps).toEqual([[8, 9]]);
    cov = coverRange(cov, 8, 8); // split/shrink
    expect(cov.gaps).toEqual([[9, 9]]);
    cov = coverRange(cov, 9, 9);
    expect(cov.gaps).toEqual([]);
  });
});
