// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure interval algebra for per-indexable coverage cursors (spec §7).
//
// A coverage value is the compact record of which blocks an indexable has
// processed: covered set = [low, high] \ gaps, plus a prunedFloor below which
// the node's state is unreadable. Two folds grow it — item completion
// (`coverRange(n, n)`) and the walker's range-completion records
// (`coverRange(a, b)`), which are what make winner-domain coverage converge
// to a contiguous interval instead of a permanent non-winner gap set.
//
// Everything here is pure and synchronous; persistence (meta KV JSON) and
// generation guarding live in the DB adapter (`setCoverageIfGeneration`).

export type Interval = readonly [number, number];

export interface Coverage {
  readonly v: 1;
  readonly gen: number;
  // Genesis floor for the indexable (startBlock()); the solver never asks
  // for work below it.
  readonly start: number;
  // Bounds of the covered territory; both null when nothing is covered yet.
  readonly low: number | null;
  readonly high: number | null;
  // Uncovered intervals strictly inside (low, high): sorted, disjoint,
  // non-adjacent.
  readonly gaps: readonly Interval[];
  // Highest block known unreadable on this node (state pruned), or null.
  // Ratchets up during a run; a boot re-probe may lower or clear it.
  readonly prunedFloor: number | null;
  // Stamped at serialization time; informational only.
  readonly updatedAt: string | null;
}

export function emptyCoverage(gen: number, start: number): Coverage {
  return { v: 1, gen, start, low: null, high: null, gaps: [], prunedFloor: null, updatedAt: null };
}

/** Subtract [a, b] from a sorted disjoint gap list (trim / split / drop). */
function subtractRange(gaps: readonly Interval[], a: number, b: number): Interval[] {
  const out: Interval[] = [];
  for (const [ga, gb] of gaps) {
    if (gb < a || ga > b) {
      out.push([ga, gb]); // untouched
      continue;
    }
    if (ga < a) out.push([ga, a - 1]); // left remnant
    if (gb > b) out.push([b + 1, gb]); // right remnant
  }
  return out;
}

/**
 * Fold a completed range (or item, when a === b) into the covered set.
 * Extending past the old bounds records the skipped stretch as a gap; covering
 * inside shrinks or splits the gap it lands in. Idempotent.
 */
export function coverRange(cov: Coverage, a: number, b: number): Coverage {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
    throw new Error(`coverRange: invalid range [${a}, ${b}]`);
  }
  if (cov.low === null || cov.high === null) {
    return { ...cov, low: a, high: b, gaps: [] };
  }

  const gaps: Interval[] = [...cov.gaps];
  // Raising high past high+1 leaves (high, a) unprocessed — a gap. Same
  // mirrored for low. These stretches are disjoint from existing gaps (which
  // live strictly inside the old bounds), so plain pushes stay disjoint.
  if (a > cov.high + 1) gaps.push([cov.high + 1, a - 1]);
  if (b < cov.low - 1) gaps.push([b + 1, cov.low - 1]);

  const next = subtractRange(gaps, a, b).sort((x, y) => x[0] - y[0]);
  return {
    ...cov,
    low: Math.min(cov.low, a),
    high: Math.max(cov.high, b),
    gaps: next,
  };
}

/** Lowest block the solver may demand: the pruned floor clips the start. */
function effectiveStart(cov: Coverage): number {
  return cov.prunedFloor === null ? cov.start : Math.max(cov.start, cov.prunedFloor + 1);
}

/**
 * The solver (spec §5/§7): every block in [effectiveStart, head] not in the
 * covered set, as sorted disjoint intervals — gaps ∪ [effStart, low) ∪ (high, head].
 */
export function uncovered(cov: Coverage, head: number): Interval[] {
  const effStart = effectiveStart(cov);
  if (head < effStart) return [];
  if (cov.low === null || cov.high === null) return [[effStart, head]];

  const out: Interval[] = [];
  if (effStart < cov.low) out.push([effStart, Math.min(cov.low - 1, head)]);
  for (const [ga, gb] of cov.gaps) {
    const a = Math.max(ga, effStart);
    const b = Math.min(gb, head);
    if (a <= b) out.push([a, b]);
  }
  const tailStart = Math.max(cov.high + 1, effStart);
  if (tailStart <= head) out.push([tailStart, head]);
  return out.sort((x, y) => x[0] - y[0]);
}

export function isComplete(cov: Coverage, head: number): boolean {
  return uncovered(cov, head).length === 0;
}

/** Ratchet: records a deeper unreadable block, never forgets a shallower one. */
export function raisePrunedFloor(cov: Coverage, n: number): Coverage {
  const floor = cov.prunedFloor === null ? n : Math.max(cov.prunedFloor, n);
  return { ...cov, prunedFloor: floor };
}

/**
 * Boot re-probe result (spec §8): the node's actual state depth right now.
 * May lower or clear the floor so archive rotation self-deepens history.
 */
export function reprobePrunedFloor(cov: Coverage, n: number | null): Coverage {
  return { ...cov, prunedFloor: n };
}

export function serializeCoverage(cov: Coverage, updatedAtIso: string): string {
  return JSON.stringify({ ...cov, updatedAt: updatedAtIso });
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

/**
 * Strict structural validation of a persisted coverage JSON. Returns null on
 * anything malformed — callers treat that as empty coverage and re-walk;
 * idempotent row writes make the replay a no-op.
 */
export function parseCoverage(raw: unknown): Coverage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isInt(r.gen) || !isInt(r.start)) return null;

  const low = r.low === null ? null : isInt(r.low) ? r.low : undefined;
  const high = r.high === null ? null : isInt(r.high) ? r.high : undefined;
  if (low === undefined || high === undefined) return null;
  if ((low === null) !== (high === null)) return null;
  if (low !== null && high !== null && low > high) return null;

  if (!Array.isArray(r.gaps)) return null;
  const gaps: Interval[] = [];
  let prevEnd = -Infinity;
  for (const g of r.gaps) {
    if (!Array.isArray(g) || g.length !== 2 || !isInt(g[0]) || !isInt(g[1])) return null;
    const [a, b] = g as [number, number];
    if (a > b) return null;
    if (low === null || high === null) return null; // gaps require bounds
    if (a <= low || b >= high) return null; // strictly inside
    if (a <= prevEnd + 1) return null; // sorted, disjoint, non-adjacent
    prevEnd = b;
    gaps.push([a, b]);
  }

  const prunedFloor = r.prunedFloor === null || r.prunedFloor === undefined ? null : r.prunedFloor;
  if (prunedFloor !== null && !isInt(prunedFloor)) return null;

  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : null;

  return { v: 1, gen: r.gen, start: r.start, low, high, gaps, prunedFloor, updatedAt };
}
