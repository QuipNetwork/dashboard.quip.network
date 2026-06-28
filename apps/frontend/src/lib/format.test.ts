// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { formatDuration, formatNumber, formatSeconds } from "./format";

describe("formatSeconds", () => {
  it("uses appropriate unit for the magnitude", () => {
    expect(formatSeconds(12.3)).toBe("12.3s");
    expect(formatSeconds(600)).toBe("10.0m");
    expect(formatSeconds(7200)).toBe("2.0h");
  });
});

describe("formatNumber", () => {
  it("adds thousands separators", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(12.345)).toBe("12.3");
  });
});

describe("formatDuration", () => {
  it("renders two largest units and never three", () => {
    expect(formatDuration(30 * 1000)).toBe("30s");
    expect(formatDuration(90 * 1000)).toBe("1m");
    expect(formatDuration(3 * 60 * 60 * 1000 + 25 * 60 * 1000)).toBe("3h 25m");
    expect(formatDuration(2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)).toBe("2d 5h");
  });

  it("handles invalid input", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});
