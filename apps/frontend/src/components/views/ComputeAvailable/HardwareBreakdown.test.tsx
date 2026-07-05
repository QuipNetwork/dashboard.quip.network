// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { formatModelLabel } from "./HardwareBreakdown";

describe("formatModelLabel", () => {
  it("passes short canonical names through unchanged", () => {
    expect(formatModelLabel("AMD EPYC")).toBe("AMD EPYC");
    expect(formatModelLabel("NVIDIA RTX 3060")).toBe("NVIDIA RTX 3060");
  });

  it("strips vendor noise markers and clock-speed suffixes", () => {
    expect(formatModelLabel("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")).toBe(
      "Intel Xeon CPU E5-268…",
    );
    expect(formatModelLabel("Intel(R) Core(TM) i9 @ 3.50GHz")).toBe("Intel Core i9");
  });

  it("collapses whitespace left behind by stripping", () => {
    expect(formatModelLabel("AMD   Ryzen  9")).toBe("AMD Ryzen 9");
  });

  it("end-truncates long names with an ellipsis", () => {
    const label = formatModelLabel("NVIDIA GeForce RTX 2060 SUPER Mobile");
    expect(label.length).toBeLessThanOrEqual(22);
    expect(label.endsWith("…")).toBe(true);
  });
});
