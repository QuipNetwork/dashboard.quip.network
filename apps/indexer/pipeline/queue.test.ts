// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QueueCore (spec §5): pure, clock-injected priority queue. Tip bucket always
// drains first (structural bias); two backfill lanes (W = winner enumeration,
// D = dense) each with their own token bucket; a tip-quiet gate holds all
// backfill pulls for 750ms after the last live substrate event.

import { describe, expect, test } from "bun:test";

import { QueueCore, type WorkItem } from "./queue";

const T0 = 1_750_000_000_000;

function makeQueue(opts: { lastEventAtMs?: number | null; rate?: number } = {}): QueueCore {
  return new QueueCore({
    backfillBlocksPerSec: opts.rate ?? 5,
    tipQuietMs: 750,
    lastEventAtMs: () => opts.lastEventAtMs ?? null,
  });
}

function pullBlock(q: QueueCore, now: number): number {
  const r = q.tryPull(now);
  if (r === "empty" || !("block" in (r as WorkItem)))
    throw new Error(`expected item, got ${JSON.stringify(r)}`);
  return (r as WorkItem).block;
}

describe("pull order", () => {
  test("tip drains first, FIFO; then lane W newest-first; then lane D", () => {
    const q = makeQueue();
    q.enqueueBackfill(300, "D", new Set(["authorship"]));
    q.enqueueBackfill(200, "D", new Set(["authorship"]));
    q.enqueueBackfill(150, "W", new Set(["winners"]));
    q.enqueueBackfill(160, "W", new Set(["winners"]));
    q.enqueueTip(500, new Set(["winners", "authorship"]));
    q.enqueueTip(501, new Set(["winners", "authorship"]));

    expect(pullBlock(q, T0)).toBe(500); // tip FIFO
    expect(pullBlock(q, T0)).toBe(501);
    expect(pullBlock(q, T0)).toBe(160); // lane W, newest first
    expect(pullBlock(q, T0)).toBe(150);
    expect(pullBlock(q, T0)).toBe(300); // lane D, newest first
    expect(pullBlock(q, T0)).toBe(200);
    expect(q.tryPull(T0)).toBe("empty");
  });

  test("tip pulls are never rate-limited", () => {
    const q = makeQueue({ rate: 1 });
    for (let i = 0; i < 20; i++) q.enqueueTip(1000 + i, new Set(["winners"]));
    for (let i = 0; i < 20; i++) expect(pullBlock(q, T0)).toBe(1000 + i);
  });
});

describe("token buckets", () => {
  test("each lane has its own budget; exhausted lane returns retryAtMs", () => {
    const q = makeQueue({ rate: 2 });
    for (let i = 0; i < 4; i++) q.enqueueBackfill(100 + i, "W", new Set(["winners"]));
    for (let i = 0; i < 4; i++) q.enqueueBackfill(200 + i, "D", new Set(["authorship"]));

    // Lane W claims first, spends its 2 tokens.
    expect(pullBlock(q, T0)).toBe(103);
    expect(pullBlock(q, T0)).toBe(102);
    // W exhausted → lane D's own budget serves next.
    expect(pullBlock(q, T0)).toBe(203);
    expect(pullBlock(q, T0)).toBe(202);
    // Both exhausted → retry when tokens refill.
    const r = q.tryPull(T0);
    expect(r).toHaveProperty("retryAtMs");
    const retryAt = (r as { retryAtMs: number }).retryAtMs;
    expect(retryAt).toBeGreaterThan(T0);
    // After refill, lane W leads again.
    expect(pullBlock(q, retryAt)).toBe(101);
  });
});

describe("tip-quiet gate", () => {
  test("backfill holds for 750ms after the last live event; tip is exempt", () => {
    const q = makeQueue({ lastEventAtMs: T0 - 100 }); // event 100ms ago
    q.enqueueBackfill(100, "W", new Set(["winners"]));
    q.enqueueTip(500, new Set(["winners"]));

    expect(pullBlock(q, T0)).toBe(500); // tip unaffected
    const r = q.tryPull(T0);
    expect(r).toHaveProperty("retryAtMs");
    expect((r as { retryAtMs: number }).retryAtMs).toBe(T0 - 100 + 750);
    // Past the quiet window the backfill pull succeeds.
    expect(pullBlock(q, T0 + 651)).toBe(100);
  });
});

describe("dedup and promotion", () => {
  test("duplicate enqueue unions pending into the existing item", () => {
    const q = makeQueue();
    q.enqueueBackfill(100, "D", new Set(["authorship"]));
    q.enqueueBackfill(100, "D", new Set(["winners"]));
    const item = q.tryPull(T0) as WorkItem;
    expect(item.block).toBe(100);
    expect([...item.pending].sort()).toEqual(["authorship", "winners"]);
    expect(q.tryPull(T0)).toBe("empty");
  });

  test("rule 1: tip enqueue promotes a backfill item — source flips to tip", () => {
    const q = makeQueue({ lastEventAtMs: T0 }); // quiet gate ON: backfill unpullable
    q.enqueueBackfill(100, "W", new Set(["winners"]));
    q.enqueueTip(100, new Set(["authorship"]));
    const item = q.tryPull(T0) as WorkItem; // pullable ⇒ it sits in the tip bucket
    expect(item.block).toBe(100);
    expect(item.source).toBe("tip");
    expect(item.lane).toBeNull();
    expect([...item.pending].sort()).toEqual(["authorship", "winners"]);
  });

  test("rule 2: lane-W enqueue promotes a lane-D item", () => {
    const q = makeQueue();
    q.enqueueBackfill(100, "D", new Set(["authorship"]));
    q.enqueueBackfill(150, "D", new Set(["authorship"]));
    q.enqueueBackfill(100, "W", new Set(["winners"]));
    // 100 must now outrank 150: lane W sorts ahead of lane D.
    const first = q.tryPull(T0) as WorkItem;
    expect(first.block).toBe(100);
    expect(first.lane).toBe("W");
    expect([...first.pending].sort()).toEqual(["authorship", "winners"]);
  });

  test("rule 3: reverse-direction duplicates never demote", () => {
    const q = makeQueue({ lastEventAtMs: T0 });
    q.enqueueTip(100, new Set(["winners"]));
    q.enqueueBackfill(100, "D", new Set(["authorship"])); // must stay tip
    const item = q.tryPull(T0) as WorkItem; // pullable under quiet gate ⇒ tip
    expect(item.source).toBe("tip");
    expect([...item.pending].sort()).toEqual(["authorship", "winners"]);

    const q2 = makeQueue();
    q2.enqueueBackfill(200, "W", new Set(["winners"]));
    q2.enqueueBackfill(200, "D", new Set(["authorship"])); // must stay W
    const item2 = q2.tryPull(T0) as WorkItem;
    expect(item2.lane).toBe("W");
    expect([...item2.pending].sort()).toEqual(["authorship", "winners"]);
  });

  test("inflight blocks drop duplicate enqueues; completed blocks re-enqueue", () => {
    const q = makeQueue();
    q.enqueueBackfill(100, "D", new Set(["authorship"]));
    const item = q.tryPull(T0) as WorkItem;
    expect(item.block).toBe(100);

    q.enqueueBackfill(100, "D", new Set(["authorship"])); // inflight → dropped
    expect(q.tryPull(T0)).toBe("empty");

    q.complete(100);
    q.enqueueBackfill(100, "D", new Set(["authorship"])); // re-enqueue allowed
    expect(pullBlock(q, T0)).toBe(100);
  });
});

describe("drain state and depth", () => {
  test("isDrained only when buckets empty and nothing inflight", () => {
    const q = makeQueue();
    expect(q.isDrained()).toBe(true);
    q.enqueueBackfill(100, "D", new Set(["authorship"]));
    expect(q.isDrained()).toBe(false);
    q.tryPull(T0);
    expect(q.isDrained()).toBe(false); // inflight
    q.complete(100);
    expect(q.isDrained()).toBe(true);
  });

  test("backfillDepth reports per-lane queue depth", () => {
    const q = makeQueue();
    q.enqueueBackfill(1, "W", new Set(["winners"]));
    q.enqueueBackfill(2, "W", new Set(["winners"]));
    q.enqueueBackfill(3, "D", new Set(["authorship"]));
    expect(q.backfillDepth("W")).toBe(2);
    expect(q.backfillDepth("D")).toBe(1);
  });
});
