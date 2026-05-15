// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import {
  markPlanEntriesDone,
  reorderCanonicalFirst,
  runBackfillIteration,
} from "./backfill-worker";
import { QuipClient } from "./client";
import type { CanonicalEpoch } from "./shared";
import { IndexerState } from "./state";
import {
  FakeDb,
  buildBlockPayload,
  makeConfig,
  makeFetch,
  statusBody,
  type Router,
} from "./test-helpers";

// Frozen wall-clock used across deterministic assertions.
const FIXED_MS = 1_700_000_000_000;

/**
 * Router that serves:
 *  - /status and /epochs bodies from the supplied fixtures
 *  - /blocks/<epoch>/<index> from `chainOf(epoch)` so tests can put two
 *    epochs on the same or different chain by assigning matching or
 *    distinct block-1 hashes.
 */
function backfillRouter(opts: {
  status: Record<string, unknown>;
  epochs: Array<Record<string, unknown>>;
  chainOf: (epoch: string) => string;
  onBlockFetch?: (epoch: string, index: number) => void;
}): Router {
  return (url) => {
    if (url.endsWith("/api/v1/telemetry/status")) {
      return { status: 200, body: opts.status };
    }
    if (url.endsWith("/api/v1/telemetry/epochs")) {
      return { status: 200, body: { epochs: opts.epochs } };
    }
    const m = url.match(/\/epochs\/([^/]+)\/blocks\/(\d+)$/);
    if (m) {
      const epoch = m[1]!;
      const idx = Number(m[2]);
      opts.onBlockFetch?.(epoch, idx);
      return { status: 200, body: buildBlockPayload(epoch, idx, 123, opts.chainOf(epoch)) };
    }
    return { status: 404 };
  };
}

function makeClient(router: Router): QuipClient {
  return new QuipClient({
    baseUrl: "https://node.example.com",
    fetchImpl: makeFetch(router),
  });
}

describe("reorderCanonicalFirst", () => {
  it("puts canonical-chain entries before dead-fork entries, preserving inner order", () => {
    const plan: CanonicalEpoch[] = [
      { epoch: "dead1", chainAnchor: "anchorDead", ownedStart: 1, ownedEnd: 3 },
      { epoch: "canonA", chainAnchor: "anchorCanon", ownedStart: 1, ownedEnd: 10 },
      { epoch: "canonTip", chainAnchor: "anchorCanon", ownedStart: 11, ownedEnd: 20 },
    ];
    const out = reorderCanonicalFirst(plan, "canonTip");
    expect(out.map((e) => e.epoch)).toEqual(["canonA", "canonTip", "dead1"]);
  });

  it("returns the plan unchanged when the tip epoch is not present", () => {
    const plan: CanonicalEpoch[] = [
      { epoch: "a", chainAnchor: "x", ownedStart: 1, ownedEnd: 3 },
      { epoch: "b", chainAnchor: "y", ownedStart: 1, ownedEnd: 3 },
    ];
    const out = reorderCanonicalFirst(plan, "ghost");
    expect(out).toEqual(plan);
  });

  it("places canonical chain first even when its anchor alphabetizes AFTER a dead chain's", () => {
    // "anchor-zzz" > "anchor-aaa" lexicographically — the buildCanonicalPlan
    // stable-sort would put the dead chain first. reorderCanonicalFirst must
    // override that so live-history indexing walks ahead of the fork.
    const plan: CanonicalEpoch[] = [
      { epoch: "deadA", chainAnchor: "anchor-aaa", ownedStart: 1, ownedEnd: 5 },
      { epoch: "canon1", chainAnchor: "anchor-zzz", ownedStart: 1, ownedEnd: 7 },
      { epoch: "canonTip", chainAnchor: "anchor-zzz", ownedStart: 8, ownedEnd: 9 },
    ];
    const out = reorderCanonicalFirst(plan, "canonTip");
    expect(out.map((e) => e.epoch)).toEqual(["canon1", "canonTip", "deadA"]);
  });
});

describe("markPlanEntriesDone", () => {
  it("marks done=true only when every owned index is already in blocks", async () => {
    const db = new FakeDb();
    for (let i = 1; i <= 5; i++) {
      await db.insertBlock({
        epoch: "prior",
        blockIndex: i,
        blockHash: `h-${i}`,
        timestamp: i,
        previousHash: `p-${i}`,
        minerId: "m",
        minerCategory: "CPU",
        ecdsaPublicKey: "pk",
        energy: 0,
        diversity: 0,
        numValidSolutions: 0,
        miningTime: 0,
        nonce: "0",
        numNodes: 0,
        numEdges: 0,
        difficultyEnergy: 0,
        minDiversity: 0,
        minSolutions: 0,
        substrateBlockNumber: null,
        substrateBlockHash: null,
        substrateParentHash: null,
        extrinsicsRoot: null,
        stateRoot: null,
        finalized: false,
        isCanonical: true,
      });
    }
    const plan: CanonicalEpoch[] = [
      { epoch: "prior", chainAnchor: "a", ownedStart: 1, ownedEnd: 5 },
      { epoch: "prior", chainAnchor: "a", ownedStart: 1, ownedEnd: 10 },
    ];
    const out = await markPlanEntriesDone(plan, db);
    expect(out[0]!.done).toBe(true);
    expect(out[1]!.done).toBe(false);
  });
});

describe("runBackfillIteration", () => {
  it("skips the tip epoch and indexes the prior epoch's owned range", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const tipBlockFetches: number[] = [];
    const priorBlockFetches: number[] = [];
    const client = makeClient(
      backfillRouter({
        status: statusBody("tip", 10),
        epochs: [
          { epoch: "prior", block_count: 5, first_block: 1, last_block: 5, status: "stale_fork" },
          { epoch: "tip", block_count: 10, first_block: 1, last_block: 10, status: "live" },
        ],
        chainOf: () => "canonical",
        onBlockFetch: (epoch, idx) => {
          if (epoch === "tip") tipBlockFetches.push(idx);
          else if (epoch === "prior" && idx > 1) priorBlockFetches.push(idx);
        },
      }),
    );

    const r = await runBackfillIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      new AbortController().signal,
    );

    // The tip worker owns `tip`. Backfill should never fetch a tip block
    // (block 1 is fetched by buildCanonicalPlan to resolve chain anchors —
    // that's fine, buildCanonicalPlan always touches block 1).
    expect(tipBlockFetches).toEqual([1]);
    // prior owns 1..5 and none are in the DB, so we insert them all.
    expect(db.inserted.map((b) => [b.epoch, b.blockIndex])).toEqual([
      ["prior", 1],
      ["prior", 2],
      ["prior", 3],
      ["prior", 4],
      ["prior", 5],
    ]);
    expect(priorBlockFetches).toEqual([2, 3, 4, 5]);
    expect(r.idle).toBe(false);
    expect(r.blocksIndexed).toBe(5);
  });

  it("enters idle and clears backfillCursor when no undone entry remains", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    state.backfillCursor = { epoch: "ghost", blockIndex: 3 };
    await state.save();

    const client = makeClient(
      backfillRouter({
        status: statusBody("tip", 5),
        epochs: [{ epoch: "tip", block_count: 5, first_block: 1, last_block: 5, status: "live" }],
        chainOf: () => "canonical",
      }),
    );

    const r = await runBackfillIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      new AbortController().signal,
    );

    expect(r.idle).toBe(true);
    expect(state.backfillCursor).toEqual({ epoch: null, blockIndex: 0 });
  });

  it("resumes a partially-indexed entry without re-fetching covered blocks", async () => {
    const db = new FakeDb();
    for (let i = 1; i <= 3; i++) {
      await db.insertBlock({
        epoch: "prior",
        blockIndex: i,
        blockHash: `hash-canonical-${i}`,
        timestamp: 1_700_000_000 + i,
        previousHash: `prev-${i}`,
        minerId: "m",
        minerCategory: "CPU",
        ecdsaPublicKey: "pk",
        energy: 0,
        diversity: 0,
        numValidSolutions: 0,
        miningTime: 0,
        nonce: "0",
        numNodes: 0,
        numEdges: 0,
        difficultyEnergy: 0,
        minDiversity: 0,
        minSolutions: 0,
        substrateBlockNumber: null,
        substrateBlockHash: null,
        substrateParentHash: null,
        extrinsicsRoot: null,
        stateRoot: null,
        finalized: false,
        isCanonical: true,
      });
    }
    const state = new IndexerState(db);
    await state.load();
    // Pre-seed the tip's chain anchor so buildCanonicalPlan doesn't need to
    // fetch its block 1 at all — makes the "which prior-block indices did we
    // fetch?" assertion unambiguous.
    state.chainAnchors.set("tip", "hash-canonical-1");
    state.chainAnchors.set("prior", "hash-canonical-1");

    const priorFetches: number[] = [];
    const client = makeClient(
      backfillRouter({
        status: statusBody("tip", 10),
        epochs: [
          { epoch: "prior", block_count: 5, first_block: 1, last_block: 5, status: "stale_fork" },
          { epoch: "tip", block_count: 10, first_block: 1, last_block: 10, status: "live" },
        ],
        chainOf: () => "canonical",
        onBlockFetch: (epoch, idx) => {
          if (epoch === "prior") priorFetches.push(idx);
        },
      }),
    );

    await runBackfillIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      new AbortController().signal,
    );

    // Only indices 4 and 5 should be fetched — 1..3 were already in DB.
    expect(priorFetches).toEqual([4, 5]);
    expect(state.backfillCursor).toEqual({ epoch: "prior", blockIndex: 5 });
  });

  it("rethrows RateLimitError from a block fetch so the loop can back off", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tip", "hash-canonical-1");
    state.chainAnchors.set("prior", "hash-canonical-1");

    const router: Router = (url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, body: statusBody("tip", 10) };
      }
      if (url.endsWith("/api/v1/telemetry/epochs")) {
        return {
          status: 200,
          body: {
            epochs: [
              {
                epoch: "prior",
                block_count: 5,
                first_block: 1,
                last_block: 5,
                status: "stale_fork",
              },
              { epoch: "tip", block_count: 10, first_block: 1, last_block: 10, status: "live" },
            ],
          },
        };
      }
      // prior/blocks/2 returns 429. (prior/blocks/1 is never hit because
      // anchor is pre-seeded.)
      const m = url.match(/\/epochs\/prior\/blocks\/(\d+)$/);
      if (m) {
        const idx = Number(m[1]);
        if (idx === 2) return { status: 429 };
        return { status: 200, body: buildBlockPayload("prior", idx, 123, "canonical") };
      }
      return { status: 404 };
    };
    const client = makeClient(router);

    await expect(
      runBackfillIteration(
        { config: makeConfig(), client, db, state, now: () => FIXED_MS },
        FIXED_MS,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    // Observability is still written via the finally block.
    expect(db.observabilityWrites.length).toBe(1);
  });

  it("stops walking on abort", async () => {
    // Owned range is 1..10 (all un-indexed). Abort after the 3rd block fetch
    // so the walk must observe the signal and break — otherwise we'd fetch
    // all 10. Asserts the in-loop abort check actually short-circuits.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tip", "hash-canonical-1");
    state.chainAnchors.set("prior", "hash-canonical-1");

    const controller = new AbortController();
    const priorFetches: number[] = [];
    const client = makeClient(
      backfillRouter({
        status: statusBody("tip", 20),
        epochs: [
          { epoch: "prior", block_count: 10, first_block: 1, last_block: 10, status: "stale_fork" },
          { epoch: "tip", block_count: 20, first_block: 1, last_block: 20, status: "live" },
        ],
        chainOf: () => "canonical",
        onBlockFetch: (epoch, idx) => {
          if (epoch === "prior") {
            priorFetches.push(idx);
            if (priorFetches.length === 3) controller.abort();
          }
        },
      }),
    );

    const r = await runBackfillIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      controller.signal,
    );

    // Walk should have stopped before covering the full 1..10 range. Exact
    // count depends on when the signal is observed relative to in-flight
    // fetches — the key invariant is "fewer than the plan required".
    expect(priorFetches.length).toBeLessThan(10);
    expect(r.blocksIndexed).toBeLessThan(10);
    // Observability still flushed via finally.
    expect(db.observabilityWrites.length).toBe(1);
  });
});
