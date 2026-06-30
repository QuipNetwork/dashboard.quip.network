// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { computeCurveConstant } from "./index";

describe("computeCurveConstant", () => {
  it("matches the live default topology (h={0}, J={-1000,1000})", () => {
    // 4577 nodes, 41515 edges; jMean=1.0, hMean=0 → K = 1 * sqrt(2m/n) * n.
    const k = computeCurveConstant(4577, 41515, { set: [0] }, { set: [-1000, 1000] });
    const avgDegree = (2 * 41515) / 4577;
    const expected = 1.0 * Math.sqrt(avgDegree) * 4577;
    expect(k).not.toBeNull();
    expect(k!).toBeCloseTo(expected, 3);
    // Sanity: the chain's threshold (-14559.588 units) maps to a sensible
    // per-mille position.
    const positionMille = (-(-14559.588) * 1000) / k!;
    expect(positionMille).toBeGreaterThan(700);
    expect(positionMille).toBeLessThan(800);
  });

  it("includes the h term when h is non-zero", () => {
    // hMean for {-500,500} = 0.5; jMean for {1000} = 1.0.
    const k = computeCurveConstant(100, 400, { set: [-500, 500] }, { set: [1000] });
    const sqrtDeg = Math.sqrt((2 * 400) / 100);
    const expected = 1.0 * sqrtDeg * 100 + (0.88 * 0.5 * 100) / sqrtDeg;
    expect(k!).toBeCloseTo(expected, 6);
  });

  it("handles integerRange and continuousRange specs", () => {
    // integerRange [-2,2] as J: mean|k| over {-2,-1,0,1,2} = (2+1+0+1+2)/5 = 1.2.
    // H={0} → hMean=0, so K = jMean * sqrt(8) * 100.
    const kInt = computeCurveConstant(
      100,
      400,
      { set: [0] },
      { integerRange: { min: -2, max: 2 } },
    );
    expect(kInt!).toBeCloseTo(1.2 * Math.sqrt(8) * 100, 6);
    // continuousRange divides the discrete mean by 1000 → jMean = 0.0012.
    const kCont = computeCurveConstant(
      100,
      400,
      { set: [0] },
      { continuousRange: { min: -2, max: 2 } },
    );
    expect(kCont!).toBeCloseTo(0.0012 * Math.sqrt(8) * 100, 9);
  });

  it("returns null for unusable inputs", () => {
    expect(computeCurveConstant(0, 10, { set: [1] }, { set: [1] })).toBeNull();
    expect(computeCurveConstant(10, 0, { set: [1] }, { set: [1] })).toBeNull();
    expect(computeCurveConstant(10, 10, { set: [] }, { set: [1] })).toBeNull();
    expect(computeCurveConstant(10, 10, null, { set: [1] })).toBeNull();
  });
});
