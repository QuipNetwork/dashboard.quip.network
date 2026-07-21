// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  bestNodeId,
  buildAttemptsCurve,
  meanEventInterval,
  successProbability,
} from "./mining-cost-model";

describe("successProbability", () => {
  test("empty input is 0", () => {
    expect(successProbability([], -100)).toBe(0);
  });

  test("fraction at or below the target", () => {
    const energies = [-100, -200, -300, -400];
    expect(successProbability(energies, -100)).toBe(1); // all <= -100
    expect(successProbability(energies, -250)).toBe(0.5); // -300, -400
    expect(successProbability(energies, -500)).toBe(0); // none this deep
  });

  test("counts ties at the boundary", () => {
    expect(successProbability([-300, -300, -100], -300)).toBeCloseTo(2 / 3, 10);
  });
});

describe("meanEventInterval", () => {
  test("fewer than two events has no interval", () => {
    expect(meanEventInterval([])).toBeNull();
    expect(meanEventInterval([42])).toBeNull();
  });

  test("median gap between consecutive (sorted) timestamps", () => {
    expect(meanEventInterval([10, 40])).toBe(30);
    expect(meanEventInterval([10, 20, 40])).toBe(15); // deltas 10, 20 -> median 15
  });

  test("sorts unordered timestamps before differencing", () => {
    expect(meanEventInterval([40, 10, 20])).toBe(15);
  });
});

describe("bestNodeId", () => {
  test("empty input is null", () => {
    expect(bestNodeId([])).toBeNull();
  });

  test("returns the account with the most wins", () => {
    const blocks = [
      { minerId: "A" },
      { minerId: "B" },
      { minerId: "A" },
      { minerId: "A" },
      { minerId: "B" },
    ];
    expect(bestNodeId(blocks)).toBe("A");
  });

  test("breaks ties deterministically by id", () => {
    const blocks = [{ minerId: "B" }, { minerId: "A" }];
    expect(bestNodeId(blocks)).toBe("A");
  });
});

describe("buildAttemptsCurve", () => {
  test("empty input yields no points", () => {
    expect(buildAttemptsCurve([], 5)).toEqual({ points: [], xMin: 0, xMax: 0 });
  });

  test("a single observed energy is one attempt", () => {
    const { points } = buildAttemptsCurve([-14_500], 5);
    expect(points).toHaveLength(1);
    expect(points[0]!.attempts).toBe(1);
  });

  test("attempts = 1/P across the swept range, rising toward harder targets", () => {
    const energies = [-100, -200, -300, -400]; // N = 4
    const { points, xMin, xMax } = buildAttemptsCurve(energies, 4);
    expect(xMin).toBe(-400);
    expect(xMax).toBe(-100);
    // Easiest swept target (max energy) is met by everything -> 1 attempt.
    const easiest = points.find((p) => p.x === -100)!;
    expect(easiest.attempts).toBe(1);
    // Hardest swept target (min energy) met by 1/4 -> 4 attempts.
    const hardest = points.find((p) => p.x === -400)!;
    expect(hardest.attempts).toBe(4);
    // Monotonic non-decreasing as the target gets harder (more negative).
    const byHardness = [...points].sort((a, b) => a.x - b.x); // ascending x
    for (let i = 1; i < byHardness.length; i++) {
      expect(byHardness[i - 1]!.attempts).toBeGreaterThanOrEqual(byHardness[i]!.attempts);
    }
  });
});
