// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { formatDuration, formatEpochTimestamp, formatNumber, formatSeconds } from "./format";

describe("formatEpochTimestamp", () => {
  it("formats unix-second timestamps as a short localized date", () => {
    // Output shape depends on the test host's locale and timezone — some
    // locales render "Apr 21, 03:00", others "Apr 21 at 03:00 AM". The
    // invariant we care about is that a recognizable month name + day + time
    // all appear somewhere in the string.
    const out = formatEpochTimestamp(1776826445);
    expect(out).toMatch(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
    expect(out).toMatch(/\d{1,2}/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns raw integer for sub-1e9 ordinals", () => {
    expect(formatEpochTimestamp(42)).toBe("42");
    expect(formatEpochTimestamp(999_999_999)).toBe("999999999");
  });

  it("accepts large valid timestamps without NaN blowups", () => {
    // Year 2100-ish
    const out = formatEpochTimestamp(4_102_444_800);
    expect(out).not.toBe("NaN");
  });
});

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
