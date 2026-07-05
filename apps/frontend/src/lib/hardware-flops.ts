// SPDX-License-Identifier: AGPL-3.0-or-later

// FP32 throughput and power draw estimates for common CPUs and GPUs seen in
// quip miner payloads. Numbers are peak single-precision TFLOPS and vendor
// TDP / board power from spec sheets. The tables are intentionally short and
// hand-maintained — real hardware drifts, but a rough order-of-magnitude is
// all the "compute available" view and energy-per-win estimates need.

import type { NodeInfo, NodeSystemCpu, NodeSystemGpu } from "@quip/shared/telemetry";

export interface GpuEntry {
  pattern: RegExp;
  tflops: number;
  // Vendor TDP / board power in watts, same hand-maintained spirit as tflops.
  watts: number;
  canonical: string;
}

export interface CpuEntry {
  pattern: RegExp;
  tflopsPerCore: number;
  // Package TDP ÷ typical core count for the family, mirroring tflopsPerCore.
  wattsPerCore: number;
  canonical: string;
}

// Ordered: the first matching pattern wins, so list more specific strings
// (e.g. "RTX 4090") before broader families ("GeForce").
export const GPU_FLOPS_TABLE: GpuEntry[] = [
  { pattern: /h100/i, tflops: 67.0, watts: 700, canonical: "NVIDIA H100" },
  { pattern: /a100/i, tflops: 19.5, watts: 400, canonical: "NVIDIA A100" },
  { pattern: /\ba40\b/i, tflops: 37.4, watts: 300, canonical: "NVIDIA A40" },
  { pattern: /rtx\s*5090/i, tflops: 104.8, watts: 575, canonical: "NVIDIA RTX 5090" },
  { pattern: /rtx\s*5060/i, tflops: 23.7, watts: 145, canonical: "NVIDIA RTX 5060" },
  { pattern: /rtx\s*4090/i, tflops: 82.6, watts: 450, canonical: "NVIDIA RTX 4090" },
  { pattern: /rtx\s*4080/i, tflops: 48.7, watts: 320, canonical: "NVIDIA RTX 4080" },
  { pattern: /rtx\s*4070/i, tflops: 29.1, watts: 200, canonical: "NVIDIA RTX 4070" },
  { pattern: /rtx\s*4060/i, tflops: 22.1, watts: 115, canonical: "NVIDIA RTX 4060" },
  {
    pattern: /rtx\s*4050/i,
    tflops: 9.0,
    watts: 80,
    canonical: "NVIDIA RTX 4050 Laptop",
  },
  { pattern: /rtx\s*3090/i, tflops: 35.6, watts: 350, canonical: "NVIDIA RTX 3090" },
  { pattern: /rtx\s*3080/i, tflops: 29.8, watts: 320, canonical: "NVIDIA RTX 3080" },
  { pattern: /rtx\s*3070/i, tflops: 20.3, watts: 220, canonical: "NVIDIA RTX 3070" },
  { pattern: /rtx\s*3060/i, tflops: 12.7, watts: 170, canonical: "NVIDIA RTX 3060" },
  { pattern: /rtx\s*2080/i, tflops: 10.1, watts: 215, canonical: "NVIDIA RTX 2080" },
  { pattern: /gtx\s*1660/i, tflops: 5.0, watts: 120, canonical: "NVIDIA GTX 1660" },
  { pattern: /gtx\s*1080/i, tflops: 8.9, watts: 180, canonical: "NVIDIA GTX 1080" },
  { pattern: /l40/i, tflops: 90.5, watts: 300, canonical: "NVIDIA L40" },
  { pattern: /l4\b/i, tflops: 30.3, watts: 72, canonical: "NVIDIA L4" },
  { pattern: /t4\b/i, tflops: 8.1, watts: 70, canonical: "NVIDIA T4" },
  { pattern: /v100/i, tflops: 15.7, watts: 300, canonical: "NVIDIA V100" },
  {
    pattern: /radeon\s*rx\s*7900/i,
    tflops: 61.4,
    watts: 355,
    canonical: "AMD Radeon RX 7900",
  },
  {
    pattern: /radeon\s*rx\s*6900/i,
    tflops: 23.0,
    watts: 300,
    canonical: "AMD Radeon RX 6900",
  },
  { pattern: /mi300/i, tflops: 163.0, watts: 750, canonical: "AMD Instinct MI300" },
  { pattern: /mi250/i, tflops: 47.9, watts: 560, canonical: "AMD Instinct MI250" },
  // Apple silicon has no discrete GPU TDP — use whole-package power draw
  // under GPU load as the estimate, per SoC teardown/power-measurement data.
  { pattern: /apple\s*m1\s*max/i, tflops: 10.4, watts: 60, canonical: "Apple M1 Max GPU" },
  { pattern: /apple\s*m1\s*pro/i, tflops: 4.6, watts: 30, canonical: "Apple M1 Pro GPU" },
  { pattern: /apple\s*m1\b/i, tflops: 2.6, watts: 20, canonical: "Apple M1 GPU" },
  {
    pattern: /apple\s*m[234]\s*max/i,
    tflops: 16.0,
    watts: 80,
    canonical: "Apple M-series Max",
  },
  {
    pattern: /apple\s*m[234]\s*pro/i,
    tflops: 9.0,
    watts: 40,
    canonical: "Apple M-series Pro",
  },
  { pattern: /apple\s*m[234]/i, tflops: 4.3, watts: 20, canonical: "Apple M-series" },
];

// CPU FLOPS scales roughly linearly with core count. tflopsPerCore is a
// conservative FP32 peak estimate for each family at typical turbo clocks
// with AVX-512/NEON where applicable. wattsPerCore is package TDP divided by
// a typical core count for the family, same convention.
export const CPU_FLOPS_TABLE: CpuEntry[] = [
  { pattern: /epyc/i, tflopsPerCore: 0.12, wattsPerCore: 4.4, canonical: "AMD EPYC" }, // 280W / 64c
  {
    pattern: /threadripper/i,
    tflopsPerCore: 0.1,
    wattsPerCore: 8.8, // 280W / 32c
    canonical: "AMD Threadripper",
  },
  {
    pattern: /ryzen\s*9/i,
    tflopsPerCore: 0.09,
    wattsPerCore: 10.6, // 170W / 16c
    canonical: "AMD Ryzen 9",
  },
  {
    pattern: /ryzen\s*7/i,
    tflopsPerCore: 0.08,
    wattsPerCore: 13.1, // 105W / 8c
    canonical: "AMD Ryzen 7",
  },
  { pattern: /ryzen/i, tflopsPerCore: 0.07, wattsPerCore: 10.8, canonical: "AMD Ryzen" }, // 65W / 6c
  {
    pattern: /xeon.*platinum/i,
    tflopsPerCore: 0.13,
    wattsPerCore: 6.8, // 270W / 40c
    canonical: "Intel Xeon Platinum",
  },
  {
    pattern: /xeon.*gold/i,
    tflopsPerCore: 0.1,
    wattsPerCore: 7.5, // 150W / 20c
    canonical: "Intel Xeon Gold",
  },
  { pattern: /xeon/i, tflopsPerCore: 0.08, wattsPerCore: 11.3, canonical: "Intel Xeon" }, // 135W / 12c, older E5 class
  // Intel Core — `\s*\(tm\)` tolerates the "Core(TM) i9" form reported by
  // most Linux /proc/cpuinfo on Intel client parts.
  {
    pattern: /core(?:\s*\(tm\))?\s*i9/i,
    tflopsPerCore: 0.09,
    wattsPerCore: 10.5, // 253W / 24c
    canonical: "Intel Core i9",
  },
  {
    pattern: /core(?:\s*\(tm\))?\s*i7/i,
    tflopsPerCore: 0.07,
    wattsPerCore: 13.7, // 219W / 16c
    canonical: "Intel Core i7",
  },
  {
    pattern: /core(?:\s*\(tm\))?\s*i5/i,
    tflopsPerCore: 0.05,
    wattsPerCore: 11.0, // 154W / 14c
    canonical: "Intel Core i5",
  },
  {
    pattern: /core(?:\s*\(tm\))?\s*i3/i,
    tflopsPerCore: 0.04,
    wattsPerCore: 15.0, // 60W / 4c
    canonical: "Intel Core i3",
  },
  // KVM/QEMU guests report the emulated microarchitecture ("Broadwell",
  // "Haswell") rather than the underlying silicon. Use the emulated family
  // as the capability estimate; real host throughput is hidden from the guest.
  {
    pattern: /\(broadwell/i,
    tflopsPerCore: 0.07,
    wattsPerCore: 6.6, // 145W / 22c, Xeon E5 v4 class
    canonical: "Intel Broadwell (virt)",
  },
  {
    pattern: /\(haswell/i,
    tflopsPerCore: 0.06,
    wattsPerCore: 8.1, // 145W / 18c, Xeon E5 v3 class
    canonical: "Intel Haswell (virt)",
  },
  {
    pattern: /qemu\s*virtual/i,
    tflopsPerCore: 0.02,
    wattsPerCore: 5.0, // host silicon unknown; conservative default
    canonical: "QEMU Virtual CPU",
  },
  // DigitalOcean droplets mask the real CPU brand with a tier label.
  // "Premium-Intel" = dedicated Xeon Gold/Platinum class; "Regular" = shared
  // throttled vCPU.
  {
    pattern: /^do-premium/i,
    tflopsPerCore: 0.08,
    wattsPerCore: 7.5, // mirrors Xeon Gold class
    canonical: "DigitalOcean Premium",
  },
  {
    pattern: /^do-regular/i,
    tflopsPerCore: 0.04,
    wattsPerCore: 5.0, // shared vCPU, conservative default
    canonical: "DigitalOcean Shared",
  },
  {
    pattern: /apple\s*m[1234]/i,
    tflopsPerCore: 0.08,
    wattsPerCore: 2.5, // ~20W CPU package / 8c
    canonical: "Apple M-series",
  },
  {
    pattern: /arm|neoverse/i,
    tflopsPerCore: 0.05,
    wattsPerCore: 2.0, // ~110W / 64c, Graviton3 class
    canonical: "ARM Neoverse",
  },
];

// Fallbacks when no pattern matches. Unknown GPUs are almost always mid-range
// consumer parts; unknown CPUs span a wide range so we pick a middling value.
const GPU_DEFAULT_TFLOPS = 10.0;
const CPU_DEFAULT_TFLOPS_PER_CORE = 0.05;

// Power fallbacks, same deliberate-rough-median spirit as the TFLOPS
// defaults above. Exported so hardware-power.ts can reuse them.
export const DEFAULT_GPU_WATTS = 250;
export const DEFAULT_CPU_WATTS_PER_CORE = 5;

export interface HardwareMatch {
  canonical: string;
  tflops: number;
}

export function lookupGpu(name: string | undefined): HardwareMatch {
  if (!name) return { canonical: "Unknown GPU", tflops: GPU_DEFAULT_TFLOPS };
  for (const entry of GPU_FLOPS_TABLE) {
    if (entry.pattern.test(name)) return { canonical: entry.canonical, tflops: entry.tflops };
  }
  return { canonical: name.trim() || "Unknown GPU", tflops: GPU_DEFAULT_TFLOPS };
}

export function lookupCpu(cpu: NodeSystemCpu | undefined): HardwareMatch {
  const brand = cpu?.brand ?? "";
  const cores = cpu?.logicalCores ?? 0;
  for (const entry of CPU_FLOPS_TABLE) {
    if (entry.pattern.test(brand)) {
      return { canonical: entry.canonical, tflops: cores * entry.tflopsPerCore };
    }
  }
  return {
    canonical: brand.trim() || "Unknown CPU",
    tflops: cores * CPU_DEFAULT_TFLOPS_PER_CORE,
  };
}

export interface NodeFlopsBreakdown {
  cpuTflops: number;
  gpuTflops: number;
  totalTflops: number;
  cpuModel: string;
  gpuModels: string[];
}

export function estimateNodeFlops(node: NodeInfo): NodeFlopsBreakdown {
  const cpuMatch = lookupCpu(node.systemInfo?.cpu);
  const gpuMatches = (node.systemInfo?.gpus ?? []).map((g: NodeSystemGpu) => lookupGpu(g.name));
  const gpuTflops = gpuMatches.reduce((sum, m) => sum + m.tflops, 0);
  return {
    cpuTflops: cpuMatch.tflops,
    gpuTflops,
    totalTflops: cpuMatch.tflops + gpuTflops,
    cpuModel: cpuMatch.canonical,
    gpuModels: gpuMatches.map((m) => m.canonical),
  };
}
