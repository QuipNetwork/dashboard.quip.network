// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { energyBandPosition, energyToCurveRatio, formatDifficultyTick } from "./difficulty-curve";

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

describe("energyBandPosition", () => {
  const band = { hardEnergy: -5100, easyEnergy: -4800 };

  it("is 0 at the hard end and 1 at the easy end", () => {
    expect(energyBandPosition(-5100, band)).toBe(0);
    expect(energyBandPosition(-4800, band)).toBe(1);
    expect(energyBandPosition(-4850, band)).toBeCloseTo(250 / 300, 9);
  });

  it("does not clamp a target outside the band", () => {
    expect(energyBandPosition(-5400, band)).toBeCloseTo(-1, 9);
    expect(energyBandPosition(-4500, band)).toBeCloseTo(2, 9);
  });

  it("is null without a band or with an unordered band", () => {
    expect(energyBandPosition(-4850, null)).toBeNull();
    expect(energyBandPosition(-4850, { hardEnergy: -4800, easyEnergy: -5100 })).toBeNull();
    expect(energyBandPosition(-4850, { hardEnergy: -4800, easyEnergy: -4800 })).toBeNull();
  });
});
