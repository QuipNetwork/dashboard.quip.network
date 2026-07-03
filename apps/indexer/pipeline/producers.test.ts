// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L1 producers (spec §5): the walker's lane planning + range-completion
// tracking (the mechanism that makes winner-domain coverage converge, D1),
// the tip enqueuer's gap fill, and the reconciler's solve/prime/cross-check.

import { describe, expect, test } from "bun:test";

import type { Interval } from "./coverage";
import { BackfillWalker, TipEnqueuer, type RangeCompletion } from "./producers";
import { QueueCore, type WorkItem } from "./queue";

const T0 = 1_750_000_000_000;

function makeQueue(): QueueCore {
  return new QueueCore({
    backfillBlocksPerSec: 10_000, // effectively unlimited for these tests
    tipQuietMs: 750,
    lastEventAtMs: () => null,
  });
}

function drain(q: QueueCore, now = T0): WorkItem[] {
  const out: WorkItem[] = [];
  for (;;) {
    const r = q.tryPull(now);
    if (r === "empty") return out;
    if ("retryAtMs" in (r as { retryAtMs: number })) {
      now = (r as { retryAtMs: number }).retryAtMs;
      continue;
    }
    out.push(r as WorkItem);
    q.complete((r as WorkItem).block);
  }
}

function makeWalker(
  queue: QueueCore,
  opts: { chunkSize?: number; lowWater?: number } = {},
): { walker: BackfillWalker; records: RangeCompletion[] } {
  const records: RangeCompletion[] = [];
  const walker = new BackfillWalker({
    queue,
    wake: () => {},
    chunkSize: opts.chunkSize ?? 8,
    lowWater: opts.lowWater ?? 1000,
    onRangeComplete: (r) => records.push(r),
  });
  return { walker, records };
}

describe("BackfillWalker — lane D (dense)", () => {
  test("enqueues every uncovered number newest-first with per-block pending", () => {
    const q = makeQueue();
    const { walker } = makeWalker(q);
    walker.prime({
      winnerPlugins: new Map(),
      everyPlugins: new Map<string, Interval[]>([["authorship", [[10, 14]]]]),
      winnerSet: [],
    });
    walker.topUp();
    const items = drain(q);
    expect(items.map((i) => i.block)).toEqual([14, 13, 12, 11, 10]);
    expect(items.every((i) => i.lane === "D")).toBe(true);
    expect(items.every((i) => i.pending.has("authorship"))).toBe(true);
  });

  test("pending contains exactly the plugins whose coverage lacks the block", () => {
    const q = makeQueue();
    const { walker } = makeWalker(q);
    walker.prime({
      winnerPlugins: new Map(),
      everyPlugins: new Map<string, Interval[]>([
        ["authorship", [[10, 12]]],
        ["other-every", [[12, 14]]],
      ]),
      winnerSet: [],
    });
    walker.topUp();
    const byBlock = new Map(drain(q).map((i) => [i.block, [...i.pending].sort()]));
    expect(byBlock.get(10)).toEqual(["authorship"]);
    expect(byBlock.get(12)).toEqual(["authorship", "other-every"]);
    expect(byBlock.get(14)).toEqual(["other-every"]);
  });
});

describe("BackfillWalker — lane W (winner enumeration)", () => {
  test("enqueues only enumerated winners; zero-winner chunks emit records immediately", () => {
    const q = makeQueue();
    const { walker, records } = makeWalker(q, { chunkSize: 8 });
    walker.prime({
      winnerPlugins: new Map<string, Interval[]>([
        ["winners", [[0, 15]]],
        ["difficulty", [[0, 15]]],
      ]),
      everyPlugins: new Map(),
      winnerSet: [3, 12],
    });
    walker.topUp();
    const items = drain(q);
    // Only the winners inside [0,15] hit the queue, newest-first, lane W.
    expect(items.map((i) => i.block)).toEqual([12, 3]);
    expect(items.every((i) => i.lane === "W")).toBe(true);
    expect(records).toHaveLength(0); // both chunks hold a winner → no records yet

    // Completing 12 closes chunk [8,15] for both plugins.
    walker.notifyCompleted(12);
    expect(records.map((r) => `${r.plugin}:${r.range[0]}-${r.range[1]}`).sort()).toEqual([
      "difficulty:8-15",
      "winners:8-15",
    ]);
    walker.notifyCompleted(3);
    expect(records).toHaveLength(4);
  });

  test("a chunk with no winners at all emits its range completion without queue work", () => {
    const q = makeQueue();
    const { walker, records } = makeWalker(q, { chunkSize: 8 });
    walker.prime({
      winnerPlugins: new Map<string, Interval[]>([["winners", [[0, 7]]]]),
      everyPlugins: new Map(),
      winnerSet: [100], // outside the range
    });
    walker.topUp();
    expect(drain(q)).toHaveLength(0);
    expect(records).toEqual([{ plugin: "winners", range: [0, 7] }]);
  });

  test("range records go only to plugins whose coverage overlapped the chunk", () => {
    const q = makeQueue();
    const { walker, records } = makeWalker(q, { chunkSize: 8 });
    walker.prime({
      winnerPlugins: new Map<string, Interval[]>([
        ["winners", [[0, 7]]],
        ["difficulty", [[8, 15]]], // disjoint from winners' work
      ]),
      everyPlugins: new Map(),
      winnerSet: [],
    });
    walker.topUp();
    expect(records.map((r) => `${r.plugin}:${r.range[0]}-${r.range[1]}`).sort()).toEqual([
      "difficulty:8-15",
      "winners:0-7",
    ]);
  });

  test("topUp respects the lane low-water mark", () => {
    const q = makeQueue();
    const { walker } = makeWalker(q, { chunkSize: 1, lowWater: 3 });
    walker.prime({
      winnerPlugins: new Map(),
      everyPlugins: new Map<string, Interval[]>([["authorship", [[0, 99]]]]),
      winnerSet: [],
    });
    walker.topUp();
    // Stops topping up once depth ≥ lowWater.
    expect(q.backfillDepth("D")).toBe(3);
  });
});

describe("TipEnqueuer gap fill", () => {
  function heads(): {
    enqueuer: TipEnqueuer;
    q: QueueCore;
    push: (n: number) => void;
  } {
    const q = makeQueue();
    let cb: ((h: { number: string; hash: string }) => void) | null = null;
    const client = {
      subscribeFinalizedHeads: async (f: (h: { number: string; hash: string }) => void) => {
        cb = f;
        return () => {};
      },
    };
    const enqueuer = new TipEnqueuer(
      client as never,
      q,
      () => {},
      new Set(["winners", "authorship"]),
    );
    enqueuer.stream().subscribe({ error: () => {} });
    return { enqueuer, q, push: (n) => cb?.({ number: String(n), hash: `0x${n}` }) };
  }

  test("small head gaps (≤32) fill at tip priority; big gaps enqueue the head only", () => {
    const { q, push } = heads();
    push(100);
    push(103); // gap of 3 → 101,102,103
    let items = drain(q);
    expect(items.map((i) => i.block)).toEqual([100, 101, 102, 103]);
    expect(items.every((i) => i.source === "tip")).toBe(true);

    push(200); // gap of 97 → head only; reconciler owns the rest
    items = drain(q);
    expect(items.map((i) => i.block)).toEqual([200]);
  });
});
