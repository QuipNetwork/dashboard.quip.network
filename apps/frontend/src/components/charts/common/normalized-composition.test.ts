// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  buildNormalizedComposition,
  NORMALIZED_CPU_COUNT,
  NORMALIZED_GPU_COUNT,
  NORMALIZED_SERIES_IDS,
  NORMALIZED_SERIES_LABELS,
  QPU_BUDGET_FRACTION,
  QPU_DAILY_BUDGET_MIN,
  type NormalizedSeries,
} from "./normalized-composition";

function seriesById(series: NormalizedSeries[], id: string): NormalizedSeries {
  const found = series.find((s) => s.id === id);
  if (!found) throw new Error(`missing series ${id}`);
  return found;
}

describe("composition constants", () => {
  test("encode the specified hypothetical network", () => {
    expect(NORMALIZED_GPU_COUNT).toBe(100);
    expect(NORMALIZED_CPU_COUNT).toBe(10_000);
    expect(QPU_DAILY_BUDGET_MIN).toBe(20);
    // 20 minutes out of a 1440-minute day ~= 1.39% participation.
    expect(QPU_BUDGET_FRACTION).toBeCloseTo(20 / 1440, 12);
    expect(QPU_BUDGET_FRACTION).toBeGreaterThan(0.0138);
    expect(QPU_BUDGET_FRACTION).toBeLessThan(0.014);
  });
});

describe("buildNormalizedComposition", () => {
  test("always emits the four series with exact ids and display labels", () => {
    const series = buildNormalizedComposition({ CPU: [{ x: 1, y: 0.5 }] });
    expect(series.map((s) => s.id)).toEqual([...NORMALIZED_SERIES_IDS]);
    expect(series.map((s) => s.label)).toEqual(["CPU", "GPU", "QPU20m", "QPU100%"]);
    expect(NORMALIZED_SERIES_LABELS.QPU100).toBe("QPU100%");
    expect(NORMALIZED_SERIES_LABELS.QPU20m).toBe("QPU20m");
  });

  test("win shares sum to 100 at every difficulty with any activity", () => {
    const series = buildNormalizedComposition({
      CPU: [
        { x: -14_500, y: 0.2 },
        { x: -14_400, y: 0.1 },
      ],
      GPU: [
        { x: -14_500, y: 0.4 },
        { x: -14_400, y: 0.3 },
      ],
      QPU: [
        { x: -14_500, y: 0.1 },
        { x: -14_400, y: 0.2 },
      ],
    });
    for (const x of [-14_500, -14_400]) {
      const total = series.reduce((sum, s) => sum + s.data.find((p) => p.x === x)!.y, 0);
      expect(total).toBeCloseTo(100, 9);
    }
  });

  test("QPU100% extrapolates the 20m/day budget: share exceeds QPU20m by 1/fraction", () => {
    const series = buildNormalizedComposition({
      QPU: [{ x: -14_500, y: 0.05 }],
      CPU: [{ x: -14_500, y: 0.001 }],
    });
    const q20 = seriesById(series, "QPU20m").data[0]!.y;
    const q100 = seriesById(series, "QPU100").data[0]!.y;
    expect(q100).toBeGreaterThan(q20);
    // Renormalization preserves the pre-normalization weight ratio.
    expect(q100 / q20).toBeCloseTo(1 / QPU_BUDGET_FRACTION, 9);
  });

  test("composition counts apply: equal per-unit performance puts CPU at 100x the GPU share", () => {
    const series = buildNormalizedComposition({
      CPU: [{ x: 0, y: 0.25 }],
      GPU: [{ x: 0, y: 0.25 }],
    });
    const cpu = seriesById(series, "CPU").data[0]!.y;
    const gpu = seriesById(series, "GPU").data[0]!.y;
    // 10,000 CPUs vs 100 GPUs at identical per-unit performance.
    expect(cpu / gpu).toBeCloseTo(NORMALIZED_CPU_COUNT / NORMALIZED_GPU_COUNT, 9);
    expect(cpu + gpu).toBeCloseTo(100, 9);
  });

  test("aligns differing x ranges onto their union, treating missing samples as zero", () => {
    const series = buildNormalizedComposition({
      CPU: [
        { x: 1, y: 0.5 },
        { x: 2, y: 0.5 },
      ],
      QPU: [
        { x: 2, y: 0.5 },
        { x: 3, y: 0.5 },
      ],
    });
    for (const s of series) {
      expect(s.data.map((p) => p.x)).toEqual([1, 2, 3]);
    }
    // x=1: CPU only. x=3: QPU regimes only.
    expect(seriesById(series, "CPU").data[0]!.y).toBeCloseTo(100, 9);
    expect(seriesById(series, "QPU20m").data[0]!.y).toBe(0);
    expect(seriesById(series, "CPU").data[2]!.y).toBe(0);
    const q20 = seriesById(series, "QPU20m").data[2]!.y;
    const q100 = seriesById(series, "QPU100").data[2]!.y;
    expect(q20 + q100).toBeCloseTo(100, 9);
  });

  test("all-zero input yields zero shares, never NaN", () => {
    const series = buildNormalizedComposition({
      CPU: [{ x: 5, y: 0 }],
      GPU: [{ x: 5, y: 0 }],
      QPU: [{ x: 5, y: 0 }],
    });
    for (const s of series) {
      expect(s.data).toEqual([{ x: 5, y: 0 }]);
    }
  });

  test("negative per-unit samples are clamped to zero", () => {
    const series = buildNormalizedComposition({
      CPU: [{ x: 0, y: -1 }],
      GPU: [{ x: 0, y: 0.5 }],
    });
    expect(seriesById(series, "CPU").data[0]!.y).toBe(0);
    expect(seriesById(series, "GPU").data[0]!.y).toBeCloseTo(100, 9);
  });

  test("empty input produces four empty series", () => {
    const series = buildNormalizedComposition({});
    expect(series.map((s) => s.id)).toEqual([...NORMALIZED_SERIES_IDS]);
    for (const s of series) expect(s.data).toEqual([]);
  });
});
