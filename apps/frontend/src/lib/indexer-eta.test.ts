// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { estimateEtaMs, formatEta, pushSample, type EtaSample } from "./indexer-eta";

describe("pushSample", () => {
  it("appends the first sample", () => {
    expect(pushSample([], { atMs: 1000, remaining: 500 })).toEqual([{ atMs: 1000, remaining: 500 }]);
  });

  it("ignores a sample whose timestamp did not advance (dedup)", () => {
    const s: EtaSample[] = [{ atMs: 1000, remaining: 500 }];
    expect(pushSample(s, { atMs: 1000, remaining: 400 })).toBe(s);
    expect(pushSample(s, { atMs: 900, remaining: 400 })).toBe(s);
  });

  it("trims samples older than the trailing window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 900 },
      { atMs: 50_000, remaining: 800 },
    ];
    // window 120s: pushing at 130_000 drops the atMs:0 sample (age 130s > 120s).
    const out = pushSample(s, { atMs: 130_000, remaining: 700 }, 120_000);
    expect(out).toEqual([
      { atMs: 50_000, remaining: 800 },
      { atMs: 130_000, remaining: 700 },
    ]);
  });
});

describe("estimateEtaMs", () => {
  it("returns null with fewer than two samples", () => {
    expect(estimateEtaMs([{ atMs: 0, remaining: 100 }], 90_000)).toBeNull();
  });

  it("returns null until the sample span reaches the minimum", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 12_000 },
      { atMs: 60_000, remaining: 8_000 },
    ];
    expect(estimateEtaMs(s, 90_000)).toBeNull();
  });

  it("estimates ms-to-done from the net decline over the window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 12_000 },
      { atMs: 120_000, remaining: 8_000 },
    ];
    // closed 4000 over 120000ms => 1/30 per ms; 8000 remaining / (1/30) = 240000ms.
    expect(estimateEtaMs(s, 90_000)).toBe(240_000);
  });

  it("returns null when the deficit grew over the window (not progressing)", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 8_000 },
      { atMs: 120_000, remaining: 9_000 },
    ];
    expect(estimateEtaMs(s, 90_000)).toBeNull();
  });

  it("returns null when the deficit is flat", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 8_000 },
      { atMs: 120_000, remaining: 8_000 },
    ];
    expect(estimateEtaMs(s, 90_000)).toBeNull();
  });
});

describe("formatEta", () => {
  it("renders sub-minute as <1m", () => {
    expect(formatEta(20_000)).toBe("<1m");
  });

  it("renders minutes", () => {
    expect(formatEta(240_000)).toBe("~4m");
  });

  it("renders whole hours", () => {
    expect(formatEta(3_600_000)).toBe("~1h");
  });

  it("renders hours and minutes", () => {
    expect(formatEta(5_400_000)).toBe("~1h 30m");
  });
});
