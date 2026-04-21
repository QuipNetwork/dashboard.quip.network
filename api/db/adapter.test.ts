// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { toMinerCategory } from "./adapter";

describe("toMinerCategory", () => {
  it("accepts bare CPU/GPU/QPU from /nodes", () => {
    expect(toMinerCategory("CPU")).toBe("CPU");
    expect(toMinerCategory("GPU")).toBe("GPU");
    expect(toMinerCategory("QPU")).toBe("QPU");
  });

  it("extracts the prefix from compound block miner_type values", () => {
    // Seen in the wild on block payloads: "<category>-<variant>:<index>".
    expect(toMinerCategory("GPU-LOCAL:0")).toBe("GPU");
    expect(toMinerCategory("GPU-CUDA:1")).toBe("GPU");
    expect(toMinerCategory("CPU-LOCAL")).toBe("CPU");
    expect(toMinerCategory("QPU-DWAVE:0")).toBe("QPU");
  });

  it("normalizes case", () => {
    expect(toMinerCategory("gpu-local:0")).toBe("GPU");
  });

  it("throws on unknown prefixes so we do not silently map garbage to a category", () => {
    expect(() => toMinerCategory("TPU")).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory("FOO-BAR:0")).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory(null)).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory(42)).toThrow(/Unknown miner category/);
  });
});
