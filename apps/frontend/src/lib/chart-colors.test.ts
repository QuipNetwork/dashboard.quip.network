// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { SERIES_COLORS, SERIES_GRADIENT } from "./colors";
import { getSeriesColor, getSeriesGradient } from "./chart-colors";

describe("getSeriesColor", () => {
  test("resolves the plain type colors", () => {
    expect(getSeriesColor("CPU")).toBe(SERIES_COLORS.CPU);
    expect(getSeriesColor("GPU")).toBe(SERIES_COLORS.GPU);
    expect(getSeriesColor("QPU")).toBe(SERIES_COLORS.QPU);
    expect(getSeriesColor("OTHER")).toBe(SERIES_COLORS.OTHER);
  });

  // MiningTimeChart/WinRateByDifficultyChart bake the QPU series' live
  // budget-qualified label ("QPU20m", "QPU45m", ...) directly into the
  // series id — this must still resolve to the QPU color, not fall through
  // to the per-node hash color.
  test.each(["QPU20m", "QPU45m", "QPU45.5m"])(
    "resolves the QPU budget-qualified label %s to the QPU color",
    (id) => {
      expect(getSeriesColor(id)).toBe(SERIES_COLORS.QPU);
    },
  );

  test("falls back to a deterministic per-node color for unrecognized ids", () => {
    expect(getSeriesColor("5GNodeAddress")).toBe(getSeriesColor("5GNodeAddress"));
    expect(getSeriesColor("5GNodeAddress")).not.toBe(SERIES_COLORS.QPU);
  });
});

describe("getSeriesGradient", () => {
  test("resolves the plain type gradients", () => {
    expect(getSeriesGradient("CPU")).toEqual(SERIES_GRADIENT.CPU);
    expect(getSeriesGradient("QPU")).toEqual(SERIES_GRADIENT.QPU);
  });

  test.each(["QPU20m", "QPU45m"])(
    "resolves the QPU budget-qualified label %s to the QPU gradient",
    (id) => {
      expect(getSeriesGradient(id)).toEqual(SERIES_GRADIENT.QPU);
    },
  );

  test("falls back to a solid per-node gradient for unrecognized ids", () => {
    const [from, to] = getSeriesGradient("5GNodeAddress");
    expect(to).toBe(`${from}aa`);
  });
});
