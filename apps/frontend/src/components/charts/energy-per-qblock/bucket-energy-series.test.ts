// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { ENERGY_MAX_POINTS, bucketEnergySeries, type EnergySeries } from "./use-energy-per-qblock";

describe("bucketEnergySeries", () => {
  test("leaves points below the cap unchanged", () => {
    const series: EnergySeries[] = [
      {
        id: "CPU",
        data: [
          { x: 9, y: 100 },
          { x: 15, y: 0 },
        ],
      },
      {
        id: "GPU",
        data: [
          { x: 9, y: 0 },
          { x: 15, y: 200 },
        ],
      },
    ];
    expect(bucketEnergySeries(series)).toEqual({ series, bucketSize: 1 });
  });

  test("keeps exactly the cap unbucketed", () => {
    expect(ENERGY_MAX_POINTS).toBe(600);
    const series: EnergySeries[] = [
      {
        id: "CPU",
        data: Array.from({ length: ENERGY_MAX_POINTS }, (_, i) => ({ x: i + 1, y: i })),
      },
    ];
    expect(bucketEnergySeries(series)).toEqual({ series, bucketSize: 1 });
  });

  test("averages aligned types at each group's last qblock, including zeros and a short final group", () => {
    const count = ENERGY_MAX_POINTS + 1;
    const series: EnergySeries[] = [
      {
        id: "CPU",
        data: Array.from({ length: count }, (_, i) => ({ x: i + 1, y: (i + 1) * 100 })),
      },
      {
        id: "GPU",
        data: Array.from({ length: count }, (_, i) => ({ x: i + 1, y: i % 2 === 0 ? 100 : 0 })),
      },
    ];

    const result = bucketEnergySeries(series);
    const [cpu, gpu] = result.series;
    expect(result.bucketSize).toBe(2);
    expect(cpu?.data).toHaveLength(Math.ceil(count / 2));
    expect(cpu?.data.slice(0, 2)).toEqual([
      { x: 2, y: 150 },
      { x: 4, y: 350 },
    ]);
    expect(cpu?.data.at(-1)).toEqual({ x: count, y: count * 100 });
    expect(gpu?.data[0]).toEqual({ x: 2, y: 50 });
    expect(gpu?.data.at(-1)).toEqual({ x: count, y: 100 });
    expect(gpu?.data.map((point) => point.x)).toEqual(cpu?.data.map((point) => point.x));
    expect(series[0]?.data[0]).toEqual({ x: 1, y: 100 });
  });
});
