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

  it("parses the legacy capability-map string form", () => {
    // Oldest miners serialized a capability object as a JSON string.
    const cpuOnly = '{"cpu": {"num_cpus": 2}, "gpu": null, "qpu": null}';
    expect(toMinerCategory(cpuOnly)).toBe("CPU");
  });

  it("parses the legacy config-dump string form and picks highest capability", () => {
    // Middle-generation miners accidentally serialized their whole node
    // config into miner_type. We recover category from capability hints.
    const gpuDump =
      '{"genesis_config": "g.json", "node_name": "gpu-1", "gpu": {"yielding": true}, "cuda": {"0": {}}}';
    expect(toMinerCategory(gpuDump)).toBe("GPU");

    const qpuDump =
      '{"node_name": "qpu1", "qpu": {}, "dwave": {"solver": "Advantage2_system1.13"}}';
    expect(toMinerCategory(qpuDump)).toBe("QPU");

    const cpuDump = '{"node_name": "cpu-1", "cpu": {"num_cpus": 12}}';
    expect(toMinerCategory(cpuDump)).toBe("CPU");
  });

  it("infers GPU from metal key (Apple Silicon miners)", () => {
    expect(toMinerCategory('{"node_name": "mac", "cpu": {"num_cpus": 1}, "metal": {}}')).toBe(
      "GPU",
    );
  });

  it("infers QPU when only dwave is present without qpu key", () => {
    expect(toMinerCategory('{"dwave": {"solver": "x"}}')).toBe("QPU");
  });

  it("picks highest capability from compound multi-backend strings", () => {
    // Observed on some nodes running multiple miner backends simultaneously.
    expect(toMinerCategory("CPU[1]+EXTERNAL[2]")).toBe("CPU");
    expect(toMinerCategory("CPU[2]+GPU[1]")).toBe("GPU");
    expect(toMinerCategory("CPU[1]+QPU[1]")).toBe("QPU");
    // Order does not matter — we scan every segment.
    expect(toMinerCategory("EXTERNAL[2]+CPU[1]")).toBe("CPU");
    expect(toMinerCategory("GPU[1]+CPU[2]")).toBe("GPU");
  });

  it("does not match substrings — only full category tokens", () => {
    // Guard against false positives like "SUPERCPU" accidentally mapping to CPU.
    expect(() => toMinerCategory("SUPERCPU")).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory("MYGPUX")).toThrow(/Unknown miner category/);
  });
});
