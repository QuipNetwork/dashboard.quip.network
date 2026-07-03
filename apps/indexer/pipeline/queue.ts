// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QueueCore (spec §5): the pure, clock-injected heart of L1. Buckets and pull
// order encode the tip bias structurally:
//
//   1. tip bucket — FIFO, always drained first, never rate-limited;
//   2. lane W (winner enumeration) — newest-first, own token bucket;
//   3. lane D (dense walk) — newest-first, own token bucket.
//
// Backfill pulls are additionally held by a tip-quiet gate for `tipQuietMs`
// after the last live substrate event, keeping the shared websocket free at
// the instant a tip block arrives. All timing decisions live here; the
// impure driver in `dispatch.ts` only sleeps and retries when told.

export type BackfillLane = "W" | "D";

export interface WorkItem {
  readonly block: number;
  // Promotion may upgrade backfill → tip (rule 1); never the reverse.
  source: "tip" | "backfill";
  lane: BackfillLane | null; // null for tip items
  // Plugins that still need this block, pre-computed by the producer.
  readonly pending: Set<string>;
}

export type PullResult = WorkItem | { retryAtMs: number } | "empty";

export interface QueueCoreOpts {
  // Per-lane budget (spec §13 default: 5).
  backfillBlocksPerSec: number;
  tipQuietMs: number;
  // Epoch ms of the last live substrate event, or null before the first.
  lastEventAtMs: () => number | null;
}

/** Continuous-refill token bucket; capacity = one second's rate. */
class TokenBucket {
  private tokens: number;
  private lastAt: number | null = null;

  constructor(private readonly ratePerSec: number) {
    this.tokens = ratePerSec; // full at boot so the first pulls are instant
  }

  /** Consume one token, or report when one will be available. */
  tryTake(nowMs: number): { ok: true } | { ok: false; retryAtMs: number } {
    if (this.lastAt !== null) {
      const elapsed = Math.max(0, nowMs - this.lastAt);
      this.tokens = Math.min(this.ratePerSec, this.tokens + (elapsed * this.ratePerSec) / 1000);
    }
    this.lastAt = nowMs;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAtMs: nowMs + ((1 - this.tokens) * 1000) / this.ratePerSec };
  }
}

/** Insert keeping the array sorted descending by block (newest first). */
function insertDesc(arr: WorkItem[], item: WorkItem): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.block > item.block) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
}

export class QueueCore {
  private readonly tip: WorkItem[] = [];
  private readonly lanes: Record<BackfillLane, WorkItem[]> = { W: [], D: [] };
  private readonly buckets: Record<BackfillLane, TokenBucket>;
  // block → queued item (any bucket). Inflight = pulled but not completed.
  private readonly queued = new Map<number, WorkItem>();
  private readonly inflight = new Set<number>();

  constructor(private readonly opts: QueueCoreOpts) {
    this.buckets = {
      W: new TokenBucket(opts.backfillBlocksPerSec),
      D: new TokenBucket(opts.backfillBlocksPerSec),
    };
  }

  enqueueTip(block: number, pending: ReadonlySet<string>): void {
    // Inflight duplicates are dropped: the snapshot being processed can't be
    // amended, and the reconciler re-detects anything genuinely missed.
    if (this.inflight.has(block)) return;
    const existing = this.queued.get(block);
    if (existing) {
      for (const p of pending) existing.pending.add(p);
      if (existing.source !== "tip") {
        // Promotion rule 1: move to the tip bucket; source flips so the
        // dispatcher resolves defaultTopologyAt() live (spec §6).
        this.removeFromLane(existing);
        existing.source = "tip";
        existing.lane = null;
        this.tip.push(existing);
      }
      return;
    }
    const item: WorkItem = { block, source: "tip", lane: null, pending: new Set(pending) };
    this.queued.set(block, item);
    this.tip.push(item);
  }

  enqueueBackfill(block: number, lane: BackfillLane, pending: ReadonlySet<string>): void {
    if (this.inflight.has(block)) return;
    const existing = this.queued.get(block);
    if (existing) {
      for (const p of pending) existing.pending.add(p);
      // Rule 3: never demote — a tip item stays tip, a lane-W item stays W.
      if (existing.source === "tip" || existing.lane === lane || existing.lane === "W") return;
      // Rule 2: lane-W enqueue promotes a lane-D item.
      if (lane === "W" && existing.lane === "D") {
        this.removeFromLane(existing);
        existing.lane = "W";
        insertDesc(this.lanes.W, existing);
      }
      return;
    }
    const item: WorkItem = { block, source: "backfill", lane, pending: new Set(pending) };
    this.queued.set(block, item);
    insertDesc(this.lanes[lane], item);
  }

  tryPull(nowMs: number): PullResult {
    const tipItem = this.tip.shift();
    if (tipItem) return this.claim(tipItem);

    if (this.lanes.W.length === 0 && this.lanes.D.length === 0) return "empty";

    // Tip-quiet gate: hold ALL backfill while a live event is fresh.
    const lastEvent = this.opts.lastEventAtMs();
    if (lastEvent !== null) {
      const quietUntil = lastEvent + this.opts.tipQuietMs;
      if (nowMs < quietUntil) return { retryAtMs: quietUntil };
    }

    // Lane W claims capacity first; each lane spends only its own budget.
    let earliestRetry = Infinity;
    for (const lane of ["W", "D"] as const) {
      if (this.lanes[lane].length === 0) continue;
      const take = this.buckets[lane].tryTake(nowMs);
      if (take.ok) return this.claim(this.lanes[lane].shift()!);
      earliestRetry = Math.min(earliestRetry, take.retryAtMs);
    }
    return { retryAtMs: earliestRetry };
  }

  /** Release the block's dedup slot once its processing finished. */
  complete(block: number): void {
    this.inflight.delete(block);
  }

  backfillDepth(lane: BackfillLane): number {
    return this.lanes[lane].length;
  }

  /** Everything queued: tip bucket + both backfill lanes (observability). */
  totalDepth(): number {
    return this.tip.length + this.lanes.W.length + this.lanes.D.length;
  }

  isDrained(): boolean {
    return (
      this.tip.length === 0 &&
      this.lanes.W.length === 0 &&
      this.lanes.D.length === 0 &&
      this.inflight.size === 0
    );
  }

  private claim(item: WorkItem): WorkItem {
    this.queued.delete(item.block);
    this.inflight.add(item.block);
    return item;
  }

  private removeFromLane(item: WorkItem): void {
    if (item.lane === null) return;
    const arr = this.lanes[item.lane];
    const idx = arr.indexOf(item);
    if (idx >= 0) arr.splice(idx, 1);
  }
}
