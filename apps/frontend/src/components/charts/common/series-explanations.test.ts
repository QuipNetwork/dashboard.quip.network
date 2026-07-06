// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { explainSeries, SERIES_EXPLANATIONS } from "./series-explanations";
import { NORMALIZED_SERIES_LABELS } from "./normalized-composition";

describe("explainSeries", () => {
  it("explains the budget-limited and extrapolated normalized QPU series", () => {
    expect(explainSeries("QPU20m")).toMatch(/20 min/i);
    expect(explainSeries("QPU100%")).toMatch(/full-time|extrapolat/i);
  });

  it("explains the QPU wall-clock cost series", () => {
    expect(explainSeries("QPUWC")).toMatch(/wall.?clock|round-trip|queue/i);
  });

  it("returns undefined for plain, self-explanatory series ids", () => {
    expect(explainSeries("CPU")).toBeUndefined();
    expect(explainSeries("GPU")).toBeUndefined();
    expect(explainSeries("QPU")).toBeUndefined();
    expect(explainSeries("All")).toBeUndefined();
    expect(explainSeries("5SomeNodeId")).toBeUndefined();
  });

  it("keys the normalized regimes by their rendered labels so tooltips match", () => {
    // The charts render normalized series under NORMALIZED_SERIES_LABELS, and
    // the tooltip resolves the explanation off that same displayed id.
    expect(SERIES_EXPLANATIONS[NORMALIZED_SERIES_LABELS.QPU20m]).toBeDefined();
    expect(SERIES_EXPLANATIONS[NORMALIZED_SERIES_LABELS.QPU100]).toBeDefined();
  });
});
