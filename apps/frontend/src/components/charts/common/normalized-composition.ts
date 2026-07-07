// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Normalized hypothetical-composition model — the CANONICAL implementation
// shared by the "Normalized" mode of the by-difficulty charts (Win Rate and
// Mining per QBlock). Pure data-in/data-out: no React, no stores, no chart
// specifics.
//
// ## The model
//
// The live network's device mix is arbitrary (a handful of CPUs/GPUs and one
// QPU on a limited cloud budget), so raw win rates say more about headcount
// than about hardware. "Normalized" answers: *what would win shares look like
// if the network had a fixed reference composition?*
//
//   - 100 GPUs        (NORMALIZED_GPU_COUNT)
//   - 10,000 CPUs     (NORMALIZED_CPU_COUNT)
//   - the QPU, split into two regimes:
//       "QPU20m"  — as observed today, on its 20 min/day cloud budget
//       "QPU100%" — the same QPU extrapolated to full-time participation
//
// ## Inputs: per-unit average performance
//
// Each input curve is the *average performance of one device of that type* at
// each x (difficulty): any nonnegative rate proportional to how often a single
// average CPU / GPU / the QPU wins (or produces) at that difficulty — e.g.
// band win count divided by device count. Only relative magnitudes matter;
// the renormalization step cancels any common scale factor per x.
//
// The QPU curve is fed **as observed**, which already reflects the 20 min/day
// budget — that observed curve IS "QPU20m".
//
// ## Participation-fraction extrapolation
//
// A QPU on a 20 min/day budget can only contest QPU_BUDGET_FRACTION
// = 20 / (60*24) ~= 1.39% of a day's qblocks. Running full-time it would
// contest all of them, so its expected performance scales by the inverse:
//
//   QPU100% weight = observed QPU performance / QPU_BUDGET_FRACTION
//
// ## Renormalization
//
// At each difficulty x the four series compete in the same hypothetical
// network, so their weights are converted to shares of 100%:
//
//   weight_CPU    = NORMALIZED_CPU_COUNT * cpuPerUnit(x)
//   weight_GPU    = NORMALIZED_GPU_COUNT * gpuPerUnit(x)
//   weight_QPU20m = qpuPerUnit(x)
//   weight_QPU100 = qpuPerUnit(x) / QPU_BUDGET_FRACTION
//   share_i(x)    = 100 * weight_i / sum(weights)     (0 when all weights are 0)
//
// Input curves may cover different x ranges; the output is aligned on the
// sorted union of all x values, with missing samples treated as 0 (a device
// type that never won at that difficulty contributes nothing there).

export const NORMALIZED_GPU_COUNT = 100;
export const NORMALIZED_CPU_COUNT = 10_000;

/** Daily cloud-access budget of the QPU, in minutes. */
export const QPU_DAILY_BUDGET_MIN = 20;

/** Fraction of a day's qblocks a 20 min/day QPU can contest (~1.39%). */
export const QPU_BUDGET_FRACTION = QPU_DAILY_BUDGET_MIN / (60 * 24);

/** Device types the composition model takes observations for. */
export type NormalizedInputId = "CPU" | "GPU" | "QPU";

/** Output series ids; QPU is split into its two participation regimes. */
export type NormalizedSeriesId = "CPU" | "GPU" | "QPU20m" | "QPU100";

export const NORMALIZED_SERIES_IDS: ReadonlyArray<NormalizedSeriesId> = [
  "CPU",
  "GPU",
  "QPU20m",
  "QPU100",
];

/** Display labels — ids stay symbol-safe, labels carry the "%" suffix. */
export const NORMALIZED_SERIES_LABELS: Record<NormalizedSeriesId, string> = {
  CPU: "CPU",
  GPU: "GPU",
  QPU20m: "QPU20m",
  QPU100: "QPU100%",
};

export interface PerfPoint {
  x: number;
  y: number;
}

/** Per-unit average performance curves, keyed by device type. */
export type PerUnitPerformance = Partial<Record<NormalizedInputId, ReadonlyArray<PerfPoint>>>;

export interface NormalizedSeries {
  id: NormalizedSeriesId;
  label: string;
  data: PerfPoint[];
}

// Negative "performance" is meaningless; clamp so a bad sample can't flip a
// share negative or corrupt the renormalization denominator.
function toLookup(points: ReadonlyArray<PerfPoint> | undefined): Map<number, number> {
  const map = new Map<number, number>();
  for (const p of points ?? []) map.set(p.x, Math.max(0, p.y));
  return map;
}

/**
 * Build the four normalized win-share series (percent, summing to 100 at each
 * x with any activity) for the reference composition. See the module header
 * for the model.
 */
export function buildNormalizedComposition(perUnit: PerUnitPerformance): NormalizedSeries[] {
  const cpu = toLookup(perUnit.CPU);
  const gpu = toLookup(perUnit.GPU);
  const qpu = toLookup(perUnit.QPU);

  const xs = [...new Set([...cpu.keys(), ...gpu.keys(), ...qpu.keys()])].sort((a, b) => a - b);

  const out: Record<NormalizedSeriesId, PerfPoint[]> = { CPU: [], GPU: [], QPU20m: [], QPU100: [] };
  for (const x of xs) {
    const qpuObserved = qpu.get(x) ?? 0;
    const weights: Record<NormalizedSeriesId, number> = {
      CPU: NORMALIZED_CPU_COUNT * (cpu.get(x) ?? 0),
      GPU: NORMALIZED_GPU_COUNT * (gpu.get(x) ?? 0),
      QPU20m: qpuObserved,
      QPU100: qpuObserved / QPU_BUDGET_FRACTION,
    };
    const total = weights.CPU + weights.GPU + weights.QPU20m + weights.QPU100;
    for (const id of NORMALIZED_SERIES_IDS) {
      out[id].push({ x, y: total > 0 ? (100 * weights[id]) / total : 0 });
    }
  }

  return NORMALIZED_SERIES_IDS.map((id) => ({
    id,
    label: NORMALIZED_SERIES_LABELS[id],
    data: out[id],
  }));
}
