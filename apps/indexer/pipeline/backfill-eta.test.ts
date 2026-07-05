// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { estimateEtaSeconds, pushEtaSample, type EtaSample } from "./backfill-eta";

describe("pushEtaSample", () => {
  it("appends the first sample", () => {
    expect(pushEtaSample([], { atMs: 1000, remaining: 500 })).toEqual([
      { atMs: 1000, remaining: 500 },
    ]);
  });

  it("ignores a sample whose timestamp did not advance", () => {
    const s: EtaSample[] = [{ atMs: 1000, remaining: 500 }];
    expect(pushEtaSample(s, { atMs: 1000, remaining: 400 })).toBe(s);
    expect(pushEtaSample(s, { atMs: 900, remaining: 400 })).toBe(s);
  });

  it("trims samples older than the trailing window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 900 },
      { atMs: 50_000, remaining: 800 },
    ];
    expect(pushEtaSample(s, { atMs: 130_000, remaining: 700 }, 120_000)).toEqual([
      { atMs: 50_000, remaining: 800 },
      { atMs: 130_000, remaining: 700 },
    ]);
  });
});

describe("estimateEtaSeconds", () => {
  it("returns null with fewer than two samples", () => {
    expect(estimateEtaSeconds([{ atMs: 0, remaining: 100 }], 90_000)).toBeNull();
  });

  it("returns null until the window reaches the minimum span", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 12_000 },
      { atMs: 60_000, remaining: 8_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBeNull();
  });

  it("estimates seconds-to-done from the net decline over the window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 12_000 },
      { atMs: 120_000, remaining: 8_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBe(240);
  });

  it("returns null when the deficit grew over the window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 8_000 },
      { atMs: 120_000, remaining: 9_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBeNull();
  });

  it("returns null when the deficit is flat", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 8_000 },
      { atMs: 120_000, remaining: 8_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBeNull();
  });
});
