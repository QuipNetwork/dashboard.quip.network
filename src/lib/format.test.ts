// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { formatDuration, formatEpochId, formatNumber, formatSeconds } from "./format";

describe("formatEpochId", () => {
  it("shortens a 16-char hex hash to an 8-char prefix + ellipsis", () => {
    expect(formatEpochId("e0a08eef1dfff726")).toBe("e0a08eef…");
  });

  it("returns short-form on its own when no timestamp is provided", () => {
    expect(formatEpochId("de9c9fdb25849930")).toBe("de9c9fdb…");
  });

  it("returns short-form on its own for a null/undefined timestamp", () => {
    expect(formatEpochId("de9c9fdb25849930", null)).toBe("de9c9fdb…");
    expect(formatEpochId("de9c9fdb25849930", undefined)).toBe("de9c9fdb…");
  });

  it("suffixes a localized date when a block-1 timestamp is provided", () => {
    // Locale/timezone-dependent output; assert the short hash prefix and
    // the presence of a recognizable month-and-time fragment.
    const out = formatEpochId("e0a08eef1dfff726", 1776826445);
    expect(out.startsWith("e0a08eef… · ")).toBe(true);
    expect(out).toMatch(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns short-form when the timestamp is NaN or non-finite", () => {
    expect(formatEpochId("e0a08eef1dfff726", Number.NaN)).toBe("e0a08eef…");
    expect(formatEpochId("e0a08eef1dfff726", Number.POSITIVE_INFINITY)).toBe("e0a08eef…");
  });

  it("returns the raw string for hashes shorter than the prefix", () => {
    expect(formatEpochId("abcd")).toBe("abcd");
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
