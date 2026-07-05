// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { formatEta } from "./indexer-eta";

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
