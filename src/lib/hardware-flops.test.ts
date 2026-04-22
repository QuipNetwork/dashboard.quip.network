// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { NodeInfo } from "../types/telemetry";
import { estimateNodeFlops, lookupCpu, lookupGpu } from "./hardware-flops";

describe("lookupGpu", () => {
  it("resolves well-known models to their canonical entry", () => {
    expect(lookupGpu("NVIDIA GeForce RTX 4090").canonical).toBe("NVIDIA RTX 4090");
    expect(lookupGpu("NVIDIA A100-SXM4-80GB").canonical).toBe("NVIDIA A100");
    expect(lookupGpu("NVIDIA H100 PCIe").canonical).toBe("NVIDIA H100");
  });

  it("is case-insensitive and tolerates spacing variants", () => {
    expect(lookupGpu("rtx4090").tflops).toBe(82.6);
    expect(lookupGpu("RTX 4090").tflops).toBe(82.6);
    expect(lookupGpu("rtx  4090").tflops).toBe(82.6);
  });

  it("falls back to a default for unknown GPUs but preserves the raw name", () => {
    const r = lookupGpu("Intel Arc B580");
    expect(r.canonical).toBe("Intel Arc B580");
    expect(r.tflops).toBeGreaterThan(0);
  });

  it("returns a safe default for undefined/empty names", () => {
    expect(lookupGpu(undefined).canonical).toBe("Unknown GPU");
    expect(lookupGpu("").canonical).toBe("Unknown GPU");
  });

  it("recognizes newer NVIDIA consumer cards seen on qpu-1", () => {
    expect(lookupGpu("NVIDIA GeForce RTX 5060 Ti").canonical).toBe("NVIDIA RTX 5060");
    expect(lookupGpu("NVIDIA GeForce RTX 4060 Ti").canonical).toBe("NVIDIA RTX 4060");
    expect(lookupGpu("NVIDIA GeForce RTX 4050 Laptop GPU").canonical).toBe(
      "NVIDIA RTX 4050 Laptop",
    );
    expect(lookupGpu("NVIDIA GeForce RTX 3060").canonical).toBe("NVIDIA RTX 3060");
  });

  it("recognizes older NVIDIA consumer cards", () => {
    expect(lookupGpu("NVIDIA GeForce GTX 1660").canonical).toBe("NVIDIA GTX 1660");
    expect(lookupGpu("NVIDIA GeForce GTX 1660 Super").canonical).toBe("NVIDIA GTX 1660");
    expect(lookupGpu("NVIDIA GeForce GTX 1080").canonical).toBe("NVIDIA GTX 1080");
  });

  it("recognizes A40 and its vGPU slice variants", () => {
    expect(lookupGpu("NVIDIA A40").canonical).toBe("NVIDIA A40");
    expect(lookupGpu("NVIDIA A40-8Q").canonical).toBe("NVIDIA A40");
    expect(lookupGpu("NVIDIA A40").tflops).toBe(37.4);
  });

  it("does not confuse A40 with other datacenter cards containing 'a40' substrings", () => {
    // Hypothetical future card names that happen to contain "A40" as a
    // non-word-bounded substring should not collide with the A40 pattern.
    expect(lookupGpu("NVIDIA RTX A4000").canonical).not.toBe("NVIDIA A40");
  });

  it("handles Apple M1 family with distinct TFLOPS per variant", () => {
    expect(lookupGpu("Apple M1").canonical).toBe("Apple M1 GPU");
    expect(lookupGpu("Apple M1").tflops).toBe(2.6);
    expect(lookupGpu("Apple M1 Pro (14-core GPU)").canonical).toBe("Apple M1 Pro GPU");
    expect(lookupGpu("Apple M1 Pro (14-core GPU)").tflops).toBe(4.6);
    expect(lookupGpu("Apple M1 Max").canonical).toBe("Apple M1 Max GPU");
  });

  it("keeps M2+ routing distinct from M1", () => {
    expect(lookupGpu("Apple M3 Pro").canonical).toBe("Apple M-series Pro");
    expect(lookupGpu("Apple M4 Max").canonical).toBe("Apple M-series Max");
  });
});

describe("lookupCpu", () => {
  it("scales tflops by logical core count", () => {
    const r = lookupCpu({ brand: "Intel Xeon Gold 6248", logicalCores: 40 });
    expect(r.canonical).toBe("Intel Xeon Gold");
    expect(r.tflops).toBeCloseTo(4.0, 1);
  });

  it("returns 0 tflops when core count is missing", () => {
    const r = lookupCpu({ brand: "AMD EPYC 7763" });
    expect(r.canonical).toBe("AMD EPYC");
    expect(r.tflops).toBe(0);
  });

  it("falls back to default per-core rate for unknown CPUs", () => {
    const r = lookupCpu({ brand: "Exotic Chip XYZ", logicalCores: 10 });
    expect(r.tflops).toBeCloseTo(0.5, 2);
  });

  it("handles undefined cpu info", () => {
    const r = lookupCpu(undefined);
    expect(r.canonical).toBe("Unknown CPU");
    expect(r.tflops).toBe(0);
  });

  it("matches Intel Core brand strings with (TM) trademark marker", () => {
    // These are the exact strings observed in qpu-1 telemetry — before the
    // regex fix they all fell through to the default per-core rate.
    expect(lookupCpu({ brand: "Intel(R) Core(TM) i9-12900F", logicalCores: 16 }).canonical).toBe(
      "Intel Core i9",
    );
    expect(
      lookupCpu({ brand: "13th Gen Intel(R) Core(TM) i5-13600KF", logicalCores: 14 }).canonical,
    ).toBe("Intel Core i5");
    expect(
      lookupCpu({
        brand: "Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz",
        logicalCores: 12,
      }).canonical,
    ).toBe("Intel Core i7");
    expect(
      lookupCpu({ brand: "Intel(R) Core(TM) i3-6100 CPU @ 3.70GHz", logicalCores: 4 }).tflops,
    ).toBeCloseTo(0.16, 2); // 4 * 0.04
  });

  it("still matches Intel Core brands without a trademark marker", () => {
    // Don't regress the original form — `Core i9-13900K` must keep working.
    const r = lookupCpu({ brand: "Intel Core i9-13900K", logicalCores: 24 });
    expect(r.canonical).toBe("Intel Core i9");
    expect(r.tflops).toBeCloseTo(2.16, 2);
  });

  it("recognizes KVM/QEMU virtualized CPU brands", () => {
    expect(
      lookupCpu({ brand: "Intel Core Processor (Broadwell, no TSX, IBRS)", logicalCores: 8 })
        .canonical,
    ).toBe("Intel Broadwell (virt)");
    expect(
      lookupCpu({ brand: "Intel Core Processor (Haswell, no TSX, IBRS)", logicalCores: 4 })
        .canonical,
    ).toBe("Intel Haswell (virt)");
    expect(lookupCpu({ brand: "QEMU Virtual CPU version 2.5+", logicalCores: 2 }).canonical).toBe(
      "QEMU Virtual CPU",
    );
  });

  it("recognizes DigitalOcean tier labels", () => {
    expect(lookupCpu({ brand: "DO-Regular", logicalCores: 2 }).canonical).toBe(
      "DigitalOcean Shared",
    );
    expect(lookupCpu({ brand: "DO-Regular", logicalCores: 2 }).tflops).toBeCloseTo(0.08, 2);
    expect(lookupCpu({ brand: "DO-Premium-Intel", logicalCores: 4 }).canonical).toBe(
      "DigitalOcean Premium",
    );
  });

  it("recognizes Apple M1 as part of the M-series family", () => {
    const r = lookupCpu({ brand: "Apple M1", logicalCores: 8 });
    expect(r.canonical).toBe("Apple M-series");
    expect(r.tflops).toBeCloseTo(0.64, 2); // 8 * 0.08
  });
});

describe("estimateNodeFlops", () => {
  it("sums CPU + per-GPU tflops across the node's systemInfo", () => {
    const node: NodeInfo = {
      address: "n1",
      status: "online",
      firstSeen: 0,
      lastSeen: 0,
      lastHeartbeat: null,
      systemInfo: {
        cpu: { brand: "Intel Core i9-13900K", logicalCores: 24 },
        gpus: [
          { index: 0, vendor: "NVIDIA", name: "NVIDIA RTX 4090" },
          { index: 1, vendor: "NVIDIA", name: "NVIDIA RTX 4090" },
        ],
      },
    };
    const r = estimateNodeFlops(node);
    expect(r.cpuTflops).toBeCloseTo(2.16, 2); // 24 * 0.09
    expect(r.gpuTflops).toBeCloseTo(165.2, 1); // 2 * 82.6
    expect(r.totalTflops).toBeCloseTo(167.36, 1);
    expect(r.gpuModels).toEqual(["NVIDIA RTX 4090", "NVIDIA RTX 4090"]);
  });

  it("returns zeros when systemInfo is absent", () => {
    const node: NodeInfo = {
      address: "n1",
      status: "online",
      firstSeen: 0,
      lastSeen: 0,
      lastHeartbeat: null,
    };
    const r = estimateNodeFlops(node);
    expect(r.cpuTflops).toBe(0);
    expect(r.gpuTflops).toBe(0);
    expect(r.totalTflops).toBe(0);
    expect(r.gpuModels).toEqual([]);
  });
});
