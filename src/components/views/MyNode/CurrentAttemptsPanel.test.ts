// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import type { MiningAttempt } from "../../../types/telemetry";

import {
  STALE_ITERATION_MS,
  isTrailStale,
  newestIterationAgeMs,
  orderAttemptsByRecency,
} from "./CurrentAttemptsPanel";

const NOW_MS = 1_780_000_000_000;

// ts_ns is u128 nanoseconds-as-string in the wild; build it from a
// target age so the BigInt parse path is exercised exactly.
function tsNsString(ageMs: number): string {
  return `${NOW_MS - ageMs}000000`;
}

function attempt(iter: number, ageMs: number | null): MiningAttempt {
  const extra: Record<string, unknown> = {};
  if (ageMs !== null) extra["ts_ns"] = tsNsString(ageMs);
  return { iter, bestEnergyMilli: -1, resultKind: "stored", minerType: "QPU", extra };
}

describe("orderAttemptsByRecency", () => {
  test("orders by ts_ns, not iter — the cross-restart collision case", () => {
    // The bug: a long prior run reached iter 934 (24h ago); the current
    // run has only reached iter 66 (1 min ago) but appended to the same
    // dispatch_id log. Sorting by iter would float the 24h-old row to
    // the top; sorting by ts_ns must surface the fresh one.
    const ordered = orderAttemptsByRecency([
      attempt(934, 24 * 60 * 60 * 1000),
      attempt(66, 60 * 1000),
    ]);
    expect(ordered.map((a) => a.iter)).toEqual([66, 934]);
  });

  test("rows missing ts_ns sort last", () => {
    const ordered = orderAttemptsByRecency([attempt(5, null), attempt(3, 1000)]);
    expect(ordered.map((a) => a.iter)).toEqual([3, 5]);
  });

  test("equal ts_ns falls back to iter descending", () => {
    const ordered = orderAttemptsByRecency([attempt(2, 1000), attempt(7, 1000)]);
    expect(ordered.map((a) => a.iter)).toEqual([7, 2]);
  });

  test("does not mutate the input array", () => {
    const input = [attempt(1, 3000), attempt(2, 1000)];
    orderAttemptsByRecency(input);
    expect(input.map((a) => a.iter)).toEqual([1, 2]);
  });
});

describe("newestIterationAgeMs", () => {
  test("returns the age of the newest (first) row", () => {
    const ordered = orderAttemptsByRecency([attempt(66, 60_000), attempt(934, 86_400_000)]);
    expect(newestIterationAgeMs(ordered, NOW_MS)).toBe(60_000);
  });

  test("null when no row carries a parseable ts_ns", () => {
    expect(newestIterationAgeMs([attempt(1, null)], NOW_MS)).toBeNull();
  });
});

describe("isTrailStale", () => {
  test("in-flight + newest iteration older than the cutoff → stale", () => {
    const ordered = orderAttemptsByRecency([attempt(66, STALE_ITERATION_MS + 60_000)]);
    expect(isTrailStale(ordered, "in-flight", NOW_MS)).toBe(true);
  });

  test("in-flight + a fresh newest iteration → not stale", () => {
    // Even with an ancient high-iter row present, a fresh low-iter row
    // means the miner is genuinely grinding — must read as in-flight.
    const ordered = orderAttemptsByRecency([
      attempt(934, 24 * 60 * 60 * 1000),
      attempt(66, 30_000),
    ]);
    expect(isTrailStale(ordered, "in-flight", NOW_MS)).toBe(false);
  });

  test("completed dispatches are never flagged stale, even when old", () => {
    const ordered = orderAttemptsByRecency([attempt(934, 24 * 60 * 60 * 1000)]);
    expect(isTrailStale(ordered, "completed", NOW_MS)).toBe(false);
  });

  test("no parseable ts_ns → cannot conclude stale", () => {
    expect(isTrailStale([attempt(1, null)], "in-flight", NOW_MS)).toBe(false);
  });
});
