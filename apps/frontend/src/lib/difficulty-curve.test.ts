// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import {
  energyToCurveMille,
  formatDifficultyTick,
  formatDifficultyTickShort,
} from "./difficulty-curve";

const K = 19493; // live default-topology constant

describe("difficulty-curve formatters", () => {
  it("maps energy to a per-mille curve position", () => {
    expect(energyToCurveMille(-14559, K)).toBe(Math.round((14559 * 1000) / K)); // ~747
    expect(energyToCurveMille(-14559, null)).toBeNull();
    expect(energyToCurveMille(-14559, 0)).toBeNull();
  });

  it("formats with no decimal on the energy", () => {
    expect(formatDifficultyTick(-14559, K)).toBe(`${energyToCurveMille(-14559, K)}‰ (-14559)`);
    // rounds, never shows .0
    expect(formatDifficultyTick(-14559.6, K)).toContain("(-14560)");
    expect(formatDifficultyTick(-14559, null)).toBe("-14559");
  });

  it("compact form is just the per-mille (energy belongs in the tooltip)", () => {
    expect(formatDifficultyTickShort(-14559, K)).toBe(`${energyToCurveMille(-14559, K)}‰`);
    expect(formatDifficultyTickShort(-14559, null)).toBe("-14559");
  });
});
