// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resolves the device-compute-time behind a winning block, real or estimated.
// A reported `deviceAccessTimeUs` (runtime-112+, still the minority of blocks
// — see BlockRecord.deviceAccessTimeUs) is the refinement; estimating from the
// block's own shape is the PRIMARY path every consumer must handle well.

import type { BlockRecord, MinerCategory } from "@quip/shared/telemetry";

export interface ResolvedAccessTime {
  seconds: number;
  estimated: boolean;
}

// QPU access time per win when unreported, seconds. Sourced from the Phase B
// GPU-vs-QPU study (h0_gpu_vs_qpu_phaseB), which measures the actual SAPI
// access time a single r=112 submission takes — not an idealized anneal-only
// figure:
//
//   quip-protocol/test_results/h0_gpu_vs_qpu_phaseB/h0_gpu_vs_qpu_phaseB/
//     qpu_reads_diversity/comparative_frontier.json → params.qpu_access_s
//
// comparative_frontier.py:56-75 pools the three r=112 anneal arms (60/80/120
// µs — statistically equivalent at h=0, per its own comment) and takes the
// mean of the raw `qpu_access_us` field across every sample in the pooled
// set: mean(qpu_access_us) / 1e6 = 0.062066015200000005 s (62066.0152 µs).
// Cross-check against notion_page.md's fitted access model, access(r) =
// 34.6ms programming + r · 0.238ms readout, at the production r=112:
// 34.6 + 112 × 0.238 = 61.256 ms — within ~1.3% of the pooled empirical mean,
// the gap being model-fit noise vs. the sampled arms. The measured mean is
// used here since it is the direct per-solve figure, not a regression.
export const QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN = 0.0620660152;

/**
 * Resolve the seconds of device compute behind a winning block, preferring
 * the winner's self-report and falling back to an estimate when absent (the
 * normal case — see BlockRecord.deviceAccessTimeUs). The winner is assumed to
 * have participated for the entire time the block was active: CPU/GPU/OTHER
 * fall back to the block's own `miningTime` (derived block-active wall
 * time); QPU falls back to the fixed per-win estimate above, since a QPU
 * win's wall-clock participation isn't the same shape as a CPU/GPU's.
 */
export function resolveDeviceAccessTime(
  block: Pick<BlockRecord, "deviceAccessTimeUs" | "miningTime">,
  category: MinerCategory,
): ResolvedAccessTime {
  const reported = block.deviceAccessTimeUs;
  if (reported != null && Number.isFinite(reported) && reported > 0) {
    return { seconds: reported / 1_000_000, estimated: false };
  }
  if (category === "QPU") {
    return { seconds: QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN, estimated: true };
  }
  return { seconds: block.miningTime, estimated: true };
}
