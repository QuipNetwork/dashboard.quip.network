// SPDX-License-Identifier: AGPL-3.0-or-later

// Estimated electrical power draw for common CPUs/GPUs, riding the same
// hand-maintained tables as hardware-flops.ts, plus the QPU's fixed system
// draw. Used to estimate energy per mining win: watts(device) ×
// device_access_time_seconds — see estimateEnergyJoules.

import type { MinerCategory, NodeInfo, NodeSystemCpu, NodeSystemGpu } from "@quip/shared/telemetry";
import {
  CPU_FLOPS_TABLE,
  DEFAULT_CPU_WATTS_PER_CORE,
  DEFAULT_GPU_WATTS,
  GPU_FLOPS_TABLE,
} from "./hardware-flops";

// D-Wave Advantage2 system draw — user-confirmed, not a spec-sheet lookup.
// Cryogenics dominate the load, so draw is roughly constant regardless of
// duty cycle; do not scale this by access time or utilization.
export const QPU_SYSTEM_WATTS = 12_000;

// Used when a CPU reports neither physicalCores nor logicalCores, and as
// the miner-category "OTHER" bucket's assumed core count.
const FAMILY_TYPICAL_CORES = 8;

export function estimateGpuWatts(gpu: NodeSystemGpu): number {
  const name = gpu.name;
  if (!name) return DEFAULT_GPU_WATTS;
  const entry = GPU_FLOPS_TABLE.find((e) => e.pattern.test(name));
  return entry?.watts ?? DEFAULT_GPU_WATTS;
}

export function estimateCpuWatts(cpu: NodeSystemCpu): number {
  const cores = cpu.physicalCores ?? cpu.logicalCores ?? FAMILY_TYPICAL_CORES;
  const brand = cpu.brand ?? "";
  const entry = CPU_FLOPS_TABLE.find((e) => e.pattern.test(brand));
  const wattsPerCore = entry?.wattsPerCore ?? DEFAULT_CPU_WATTS_PER_CORE;
  return wattsPerCore * cores;
}

export function estimateDeviceWatts(category: MinerCategory, node?: NodeInfo | null): number {
  switch (category) {
    case "QPU":
      return QPU_SYSTEM_WATTS;
    case "GPU": {
      // One win is mined by one device — use the node's first reported GPU
      // rather than summing every GPU the node happens to have.
      const gpu = node?.systemInfo?.gpus?.[0];
      return gpu ? estimateGpuWatts(gpu) : DEFAULT_GPU_WATTS;
    }
    case "CPU": {
      const cpu = node?.systemInfo?.cpu;
      return cpu ? estimateCpuWatts(cpu) : DEFAULT_CPU_WATTS_PER_CORE * FAMILY_TYPICAL_CORES;
    }
    case "OTHER":
    default:
      return DEFAULT_CPU_WATTS_PER_CORE * FAMILY_TYPICAL_CORES;
  }
}

export function estimateEnergyJoules(watts: number, seconds: number): number {
  return watts * seconds;
}
