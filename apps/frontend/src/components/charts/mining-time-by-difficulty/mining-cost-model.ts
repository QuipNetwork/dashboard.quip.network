// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Probability/rate model behind "Mining Cost by Difficulty". Instead of
// averaging the winner's reported wall-clock per difficulty band (survivorship-
// biased noise), we estimate, from the empirical distribution of *achieved*
// energies, how rare a solution at least as good as target E is:
//
//   P(E) = fraction of observed mining events reaching energy <= E   (energy CDF)
//   A(E) = 1 / P(E)                expected # of qblock events to reach <= E
//   time(E) = A(E) * t             t = median interval between events (cadence)
//
// All helpers are pure so they unit-test without React or the stores.

export interface AttemptsPoint {
  x: number;
  attempts: number;
}

export interface AttemptsCurve {
  points: AttemptsPoint[];
  xMin: number;
  xMax: number;
}

/**
 * Empirical success probability against a target: the fraction of observed
 * energies at or below `target` (i.e. at least as good). Returns 0 for empty
 * input or a target harder than anything observed.
 */
export function successProbability(energies: number[], target: number): number {
  if (energies.length === 0) return 0;
  let count = 0;
  for (const e of energies) if (e <= target) count++;
  return count / energies.length;
}

/**
 * Median wall-clock gap between consecutive events, given their timestamps (any
 * order). This is the observed cadence — for All Nodes, the network's qblock
 * interval; for a best-nodes series, the gap between that node's wins. Null
 * when fewer
 * than two events exist (no interval can be formed).
 */
export function meanEventInterval(timestamps: number[]): number | null {
  if (timestamps.length < 2) return null;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) deltas.push(sorted[i]! - sorted[i - 1]!);
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 1 ? deltas[mid]! : (deltas[mid - 1]! + deltas[mid]!) / 2;
}

/**
 * The account that won the most blocks in the set — the "most powerful" node.
 * Ties break deterministically toward the lexicographically smaller id so the
 * best-nodes curve is stable across renders. Null for empty input.
 */
export function bestNodeId(blocks: ReadonlyArray<{ minerId: string }>): string | null {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.minerId, (counts.get(b.minerId) ?? 0) + 1);
  let best: string | null = null;
  let bestN = -1;
  for (const [id, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && id < best)) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/**
 * Narrow a block list to the wins of each category's single {@link bestNodeId}
 * — the "Best Nodes" scope shared by the by-difficulty charts. `categoryOf`
 * resolves a miner's processor type (see miner-category's `categoryFor`);
 * taking it as a function keeps this module store-free.
 */
export function filterToBestNodes<T extends { minerId: string }>(
  blocks: readonly T[],
  categoryOf: (minerId: string) => string,
): T[] {
  const byCat = new Map<string, T[]>();
  for (const b of blocks) {
    const cat = categoryOf(b.minerId);
    const group = byCat.get(cat);
    if (group) group.push(b);
    else byCat.set(cat, [b]);
  }
  const bestIds = new Set([...byCat.values()].map((group) => bestNodeId(group)));
  return blocks.filter((b) => bestIds.has(b.minerId));
}

/**
 * Sweep target energies across the observed range and compute expected attempts
 * A(E) = 1/P(E) at each. Targets span [min, max] of `energies`; P is therefore
 * always >= 1/N over the swept range, so attempts never diverge (capped at N).
 */
export function buildAttemptsCurve(energies: number[], numPoints: number): AttemptsCurve {
  if (energies.length === 0) return { points: [], xMin: 0, xMax: 0 };
  const min = Math.min(...energies);
  const max = Math.max(...energies);
  if (min === max) {
    return {
      points: [{ x: Math.round(min), attempts: 1 }],
      xMin: Math.floor(min),
      xMax: Math.ceil(max),
    };
  }
  const step = (max - min) / (numPoints - 1);
  const points: AttemptsPoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    const target = min + i * step;
    const p = successProbability(energies, target);
    points.push({ x: Math.round(target), attempts: p > 0 ? 1 / p : energies.length });
  }
  return { points, xMin: Math.floor(min), xMax: Math.ceil(max) };
}
