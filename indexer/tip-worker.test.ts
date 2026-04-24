// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { QuipClient } from "./client";
import { IndexerState } from "./state";
import {
  FakeDb,
  buildBlockPayload,
  makeConfig,
  makeFetch,
  statusBody,
  type Router,
} from "./test-helpers";
import { runTipIteration } from "./tip-worker";

// Frozen wall-clock used across deterministic assertions. 2023-11-14T22:13:20Z.
const FIXED_MS = 1_700_000_000_000;

/**
 * Build a router that returns:
 *  - a /status body
 *  - a /epochs body
 *  - per-epoch /blocks responses derived from `chainOf(epoch)` so tests can
 *    make two epochs live on the same chain (shared block-1 hash) or two
 *    live on different chains.
 */
function tipRouter(opts: {
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

describe("runTipIteration", () => {
  it("seeds tipCursor from ownedStart when a prior epoch exists on the same chain", async () => {
    // tipA is on the same chain as priorA (shared block-1 hash "canonical").
    // priorA's lastBlock=100 means tipA owns 101..102. First poll should walk
    // exactly those two blocks.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const walkIndices: number[] = [];
    const client = makeClient(
      tipRouter({
        status: statusBody("tipA", 102),
        epochs: [
          { epoch: "priorA", block_count: 100, first_block: 1, last_block: 100 },
          { epoch: "tipA", block_count: 102, first_block: 1, last_block: 102 },
        ],
        chainOf: () => "canonical",
        onBlockFetch: (epoch, idx) => {
          // Block 1 is fetched by computeTipOwnedStart to resolve chain
          // anchors; filter it out so the walk count is unambiguous.
          if (epoch === "tipA" && idx > 1) walkIndices.push(idx);
        },
      }),
    );

    const r = await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    expect(r.fetchedStatus).toBe(true);
    expect(state.tipCursor).toEqual({ epoch: "tipA", blockIndex: 102 });
    expect(db.inserted.map((b) => [b.epoch, b.blockIndex])).toEqual([
      ["tipA", 101],
      ["tipA", 102],
    ]);
    expect(walkIndices).toEqual([101, 102]);
  });

  it("resets tipCursor on epoch rollover", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    state.tipCursor = { epoch: "tipA", blockIndex: 49 };
    await state.save();

    const client = makeClient(
      tipRouter({
        status: statusBody("tipB", 50),
        epochs: [
          { epoch: "tipA", block_count: 49, first_block: 1, last_block: 49, status: "stale_fork" },
          { epoch: "tipB", block_count: 50, first_block: 1, last_block: 50, status: "live" },
        ],
        chainOf: () => "canonical",
      }),
    );

    await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    // tipA's lastBlock=49 is the prior on-chain tip; tipB owns 50..50.
    expect(state.tipCursor.epoch).toBe("tipB");
    expect(state.tipCursor.blockIndex).toBe(50);
    expect(db.inserted.map((b) => [b.epoch, b.blockIndex])).toEqual([["tipB", 50]]);
  });

  it("walks only new same-epoch blocks without re-fetching prior ones", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    state.tipCursor = { epoch: "tipA", blockIndex: 102 };
    await state.save();
    // Seed chain anchor so the owned-start computation doesn't refetch block 1
    // (irrelevant for the assertion, but keeps the touched-index set tight).
    state.chainAnchors.set("tipA", "hash-canonical-1");

    const fetchedIndices: number[] = [];
    const client = makeClient(
      tipRouter({
        status: statusBody("tipA", 105),
        epochs: [{ epoch: "tipA", block_count: 105, first_block: 1, last_block: 105 }],
        chainOf: () => "canonical",
        onBlockFetch: (_epoch, idx) => {
          fetchedIndices.push(idx);
        },
      }),
    );

    const r = await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    expect(r.blocksIndexed).toBe(3);
    expect(fetchedIndices).toEqual([103, 104, 105]);
    expect(state.tipCursor).toEqual({ epoch: "tipA", blockIndex: 105 });
  });

  it("writes observability heartbeat even when /status returns no body", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const client = makeClient((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) return { status: 304 };
      return { status: 404 };
    });

    await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    expect(db.observabilityWrites).toHaveLength(1);
    expect(db.observability?.lastStatusFetchAt).toBe(new Date(FIXED_MS).toISOString());
    // No blocks walked, no blocks inserted.
    expect(db.inserted).toHaveLength(0);
  });

  it("calls replaceEpochStatus with every /epochs entry", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const client = makeClient(
      tipRouter({
        status: statusBody("tipB", 2),
        epochs: [
          { epoch: "tipA", block_count: 1, first_block: 1, last_block: 1, status: "stale_fork" },
          { epoch: "tipB", block_count: 2, first_block: 1, last_block: 2, status: "live" },
        ],
        chainOf: () => "canonical",
      }),
    );

    await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    expect(db.epochStatus).toEqual([
      { epoch: "tipA", status: "stale_fork" },
      { epoch: "tipB", status: "live" },
    ]);
  });

  it("advances stall tracker when the node tip moves", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    state.tipCursor = { epoch: "tipA", blockIndex: 100 };
    state.stall = {
      lastObserved: { epoch: "tipA", blockIndex: 99 },
      lastAdvanceAtMs: 1_000,
      lastWarnAtMs: 0,
    };
    state.chainAnchors.set("tipA", "hash-canonical-1");
    await state.save();

    const client = makeClient(
      tipRouter({
        status: statusBody("tipA", 100),
        epochs: [{ epoch: "tipA", block_count: 100, first_block: 1, last_block: 100 }],
        chainOf: () => "canonical",
      }),
    );

    await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    expect(state.stall.lastObserved).toEqual({ epoch: "tipA", blockIndex: 100 });
    expect(state.stall.lastAdvanceAtMs).toBe(FIXED_MS);
  });
});
