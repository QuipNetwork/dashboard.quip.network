// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { energyToCurveRatio, formatDifficultyTick } from "./difficulty-curve";

const K = 19493; // live default-topology constant

describe("difficulty-curve formatters", () => {
  it("maps energy to its curve ratio c = -E/K", () => {
    expect(energyToCurveRatio(-14559, K)).toBeCloseTo(14559 / K, 9); // ~0.747
    expect(energyToCurveRatio(-14559, null)).toBeNull();
    expect(energyToCurveRatio(-14559, 0)).toBeNull();
  });

  it("formats the ratio to 3 decimals with no decimal on the energy", () => {
    // The ratio is a plain fraction of the curve constant K — not a
    // probability, so no %/‰ suffix.
    expect(formatDifficultyTick(-14559, K)).toBe("0.747 (-14559)");
    // rounds, never shows .0
    expect(formatDifficultyTick(-14559.6, K)).toContain("(-14560)");
    expect(formatDifficultyTick(-14559, null)).toBe("-14559");
  });
});
