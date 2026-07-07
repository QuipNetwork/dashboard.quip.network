// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { DEFAULT_CPU_WATTS_PER_CORE, DEFAULT_GPU_WATTS } from "@/lib/hardware-flops";
import {
  estimateCpuWatts,
  estimateDeviceWatts,
  estimateEnergyJoules,
  estimateGpuWatts,
  QPU_SYSTEM_WATTS,
} from "@/lib/hardware-power";
import type { NodeInfo, NodeSystemCpu, NodeSystemGpu } from "@quip/shared/telemetry";

function gpu(name: string): NodeSystemGpu {
  return { name };
}

function cpu(brand: string, physicalCores?: number, logicalCores?: number): NodeSystemCpu {
  return { brand, physicalCores, logicalCores };
}

function node(overrides: Partial<NodeInfo["systemInfo"]> = {}): NodeInfo {
  return {
    address: "5Node",
    status: "online",
    firstSeen: 0,
    lastSeen: 0,
    lastHeartbeat: null,
    systemInfo: overrides,
  };
}

describe("estimateGpuWatts", () => {
  test("known GPU model returns its table watts", () => {
    expect(estimateGpuWatts(gpu("NVIDIA GeForce RTX 4090"))).toBe(450);
    expect(estimateGpuWatts(gpu("Tesla T4"))).toBe(70);
  });

  test("unknown GPU model falls back to DEFAULT_GPU_WATTS", () => {
    expect(estimateGpuWatts(gpu("Some Future GPU"))).toBe(DEFAULT_GPU_WATTS);
  });

  test("missing GPU name falls back to DEFAULT_GPU_WATTS", () => {
    expect(estimateGpuWatts(gpu(undefined as unknown as string))).toBe(DEFAULT_GPU_WATTS);
  });
});

describe("estimateCpuWatts", () => {
  test("family match uses wattsPerCore × physical cores", () => {
    // EPYC: 4.4 W/core × 64 physical cores
    expect(estimateCpuWatts(cpu("AMD EPYC 7763", 64, 128))).toBe(4.4 * 64);
  });

  test("falls back to logical cores when physical cores are missing", () => {
    // Ryzen 9: 10.6 W/core × 16 logical cores
    expect(estimateCpuWatts(cpu("AMD Ryzen 9 7950X", undefined, 16))).toBe(10.6 * 16);
  });

  test("missing core counts fall back to the family-typical core count", () => {
    expect(estimateCpuWatts(cpu("AMD Ryzen 9 7950X"))).toBe(10.6 * 8);
  });

  test("unknown CPU family falls back to DEFAULT_CPU_WATTS_PER_CORE", () => {
    expect(estimateCpuWatts(cpu("Some Future CPU", 8))).toBe(DEFAULT_CPU_WATTS_PER_CORE * 8);
  });
});

describe("estimateDeviceWatts", () => {
  test("QPU is always QPU_SYSTEM_WATTS regardless of node info", () => {
    expect(estimateDeviceWatts("QPU")).toBe(QPU_SYSTEM_WATTS);
    expect(estimateDeviceWatts("QPU", node({ cpu: cpu("AMD EPYC", 64) }))).toBe(QPU_SYSTEM_WATTS);
  });

  test("GPU uses the node's first GPU", () => {
    const withGpus = node({ gpus: [gpu("NVIDIA RTX 4090"), gpu("NVIDIA T4")] });
    expect(estimateDeviceWatts("GPU", withGpus)).toBe(450);
  });

  test("GPU with no node/model falls back to DEFAULT_GPU_WATTS", () => {
    expect(estimateDeviceWatts("GPU")).toBe(DEFAULT_GPU_WATTS);
    expect(estimateDeviceWatts("GPU", node())).toBe(DEFAULT_GPU_WATTS);
  });

  test("CPU delegates to estimateCpuWatts", () => {
    const withCpu = node({ cpu: cpu("AMD EPYC 7763", 64) });
    expect(estimateDeviceWatts("CPU", withCpu)).toBe(4.4 * 64);
  });

  test("CPU with no node/model falls back to default watts per core × 8", () => {
    expect(estimateDeviceWatts("CPU")).toBe(DEFAULT_CPU_WATTS_PER_CORE * 8);
  });

  test("OTHER uses the documented rough default", () => {
    expect(estimateDeviceWatts("OTHER")).toBe(DEFAULT_CPU_WATTS_PER_CORE * 8);
  });
});

describe("estimateEnergyJoules", () => {
  test("multiplies watts by seconds", () => {
    expect(estimateEnergyJoules(450, 10)).toBe(4500);
    expect(estimateEnergyJoules(QPU_SYSTEM_WATTS, 2)).toBe(24_000);
  });
});
