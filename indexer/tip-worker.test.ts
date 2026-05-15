// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { BlockRecord } from "../src/types/telemetry";

import { AuthError, QuipClient, RateLimitError } from "./client";
import { IndexerState } from "./state";
import {
  FakeDb,
  buildBlockPayload,
  makeConfig,
  makeFetch,
  statusBody,
  type Router,
} from "./test-helpers";
import { runTipIteration, runTipLoop } from "./tip-worker";

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

  it("advances cursor and skips on 404 blocks in the middle of the tip epoch", async () => {
    // Block 2 is pruned/missing; blocks 1 and 3 resolve normally. The walker
    // should advance past the 404 rather than retry it each poll.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tipA", "hash-canonical-1");

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, body: statusBody("tipA", 3) };
      }
      if (url.endsWith("/api/v1/telemetry/epochs")) {
        return {
          status: 200,
          body: { epochs: [{ epoch: "tipA", block_count: 3, first_block: 1, last_block: 3 }] },
        };
      }
      if (/\/blocks\/2$/.test(url)) return { status: 404 };
      const m = url.match(/\/epochs\/([^/]+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(m[1]!, Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    const r = await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: FIXED_MS },
    );

    expect(r.blocksIndexed).toBe(2);
    expect(r.blocksSkipped).toBe(1);
    expect(db.inserted.map((b) => b.blockIndex).sort()).toEqual([1, 3]);
    expect(state.tipCursor).toEqual({ epoch: "tipA", blockIndex: 3 });
  });

  it("rethrows RateLimitError from getBlock and persists cursor at last successful insert", async () => {
    // Without rethrow, block-level 429s get swallowed and the loop retries
    // every pollIntervalSec — hammering the upstream instead of backing off.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tipA", "hash-canonical-1");

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, body: statusBody("tipA", 5) };
      }
      if (url.endsWith("/api/v1/telemetry/epochs")) {
        return {
          status: 200,
          body: { epochs: [{ epoch: "tipA", block_count: 5, first_block: 1, last_block: 5 }] },
        };
      }
      if (/\/blocks\/3$/.test(url)) return { status: 429 };
      const m = url.match(/\/epochs\/([^/]+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(m[1]!, Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await expect(
      runTipIteration({ config: makeConfig(), client, db, state, now: () => FIXED_MS }, FIXED_MS, {
        value: FIXED_MS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(db.inserted.map((b) => b.blockIndex)).toEqual([1, 2]);
    expect(db.savedCursors.at(-1)?.tipCursor).toEqual({ epoch: "tipA", blockIndex: 2 });
  });

  it("throws and persists cursor up to last successful insert on db error", async () => {
    const db = new FakeDb();
    let inserts = 0;
    db.insertBlock = async (b: BlockRecord): Promise<boolean> => {
      inserts += 1;
      if (inserts === 2) throw new Error("simulated db write error");
      db.inserted.push(b);
      return true;
    };
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tipA", "hash-canonical-1");

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, body: statusBody("tipA", 3) };
      }
      if (url.endsWith("/api/v1/telemetry/epochs")) {
        return {
          status: 200,
          body: { epochs: [{ epoch: "tipA", block_count: 3, first_block: 1, last_block: 3 }] },
        };
      }
      const m = url.match(/\/epochs\/([^/]+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(m[1]!, Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await expect(
      runTipIteration({ config: makeConfig(), client, db, state, now: () => FIXED_MS }, FIXED_MS, {
        value: FIXED_MS,
      }),
    ).rejects.toThrow(/simulated db write error/);

    expect(db.inserted).toHaveLength(1);
    expect(db.savedCursors.at(-1)?.tipCursor).toEqual({ epoch: "tipA", blockIndex: 1 });
  });
});

describe("runTipIteration self-address", () => {
  // /api/v1/status is the node's own identity endpoint — it returns the
  // exact peer-list key the node uses for itself. The telemetry endpoint is
  // /api/v1/telemetry/status. Router order matters: match the more specific
  // identity path first, otherwise endsWith("/status") swallows both.
  function nodesRouter(
    selfHost: string | null,
    nodes: Record<string, Record<string, unknown>>,
  ): Router {
    return (url) => {
      if (url.endsWith("/api/v1/status")) {
        return {
          status: 200,
          body: selfHost !== null ? { host: selfHost } : {},
        };
      }
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, etag: "e", body: statusBody("1000", 0) };
      }
      if (url.endsWith("/api/v1/telemetry/nodes")) {
        return {
          status: 200,
          body: {
            updated_at: "2025-01-01T00:00:00Z",
            node_count: Object.keys(nodes).length,
            active_count: Object.keys(nodes).length,
            nodes,
          },
        };
      }
      return { status: 404 };
    };
  }

  function baseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      status: "online",
      first_seen: 1,
      last_seen: 2,
      last_heartbeat: 2,
      ...overrides,
    };
  }

  it("persists the address the node reports as its own in /api/v1/status", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch(
      nodesRouter("node.example.com:20049", {
        "other.example.com:20049": baseNode({ address: "other.example.com:20049" }),
        "node.example.com:20049": baseNode({ address: "node.example.com:20049" }),
      }),
    );
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await runTipIteration(
      { config: makeConfig({ nodesRefreshSec: 0 }), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: -1_000_000 },
    );

    expect(db.selfAddress).toBe("node.example.com:20049");
  });

  it("leaves the address null when the node reports a host missing from the snapshot", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch(
      nodesRouter("node.example.com:20049", {
        "other.example.com:20049": baseNode({ address: "other.example.com:20049" }),
      }),
    );
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await runTipIteration(
      { config: makeConfig({ nodesRefreshSec: 0 }), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: -1_000_000 },
    );

    expect(db.selfAddress).toBeNull();
  });

  it("leaves the address null when the node lacks /api/v1/status (older version)", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch(
      nodesRouter(null, {
        "node.example.com:20049": baseNode({ address: "node.example.com:20049" }),
      }),
    );
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await runTipIteration(
      { config: makeConfig({ nodesRefreshSec: 0 }), client, db, state, now: () => FIXED_MS },
      FIXED_MS,
      { value: -1_000_000 },
    );

    expect(db.selfAddress).toBeNull();
  });
});

describe("runTipIteration observability persistence", () => {
  it("writes observability even when insertBlock throws", async () => {
    // Rate-limit and db-error paths rethrow; without try/finally they'd skip
    // the heartbeat and operators would lose visibility exactly when they
    // need it most.
    const db = new FakeDb();
    db.insertBlock = async (): Promise<boolean> => {
      throw new Error("simulated db write error");
    };
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tipA", "hash-canonical-1");

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, body: statusBody("tipA", 3) };
      }
      if (url.endsWith("/api/v1/telemetry/epochs")) {
        return {
          status: 200,
          body: { epochs: [{ epoch: "tipA", block_count: 3, first_block: 1, last_block: 3 }] },
        };
      }
      const m = url.match(/\/epochs\/([^/]+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(m[1]!, Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await expect(
      runTipIteration({ config: makeConfig(), client, db, state, now: () => FIXED_MS }, FIXED_MS, {
        value: FIXED_MS,
      }),
    ).rejects.toThrow(/simulated db write error/);

    // Heartbeat still advanced, even though the iteration threw.
    expect(db.observabilityWrites).toHaveLength(1);
    expect(db.observability?.lastStatusFetchAt).toBe(new Date(FIXED_MS).toISOString());
  });

  it("carries lastBlockInsertAt across iterations without new inserts", async () => {
    const db = new FakeDb();
    // Prior run persisted this timestamp. A subsequent poll with no new
    // blocks should not clobber it back to null.
    db.observability = {
      nodeLatestEpoch: "tipA",
      nodeLatestBlockIndex: 5,
      tipEpoch: "tipA",
      tipBlockIndex: 5,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-01-01T00:00:00.000Z",
      lastBlockInsertAt: "2026-01-01T00:00:00.000Z",
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
    };
    db.cursor = { epoch: "tipA", blockIndex: 5 }; // caught up
    const state = new IndexerState(db);
    await state.load();
    state.chainAnchors.set("tipA", "hash-canonical-1");

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        return { status: 200, body: statusBody("tipA", 5) };
      }
      if (url.endsWith("/api/v1/telemetry/epochs")) {
        return {
          status: 200,
          body: { epochs: [{ epoch: "tipA", block_count: 5, first_block: 1, last_block: 5 }] },
        };
      }
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await runTipIteration(
      { config: makeConfig(), client, db, state, now: () => 1_800_000_000_000 },
      1_800_000_000_000,
      { value: FIXED_MS },
    );

    expect(db.observability?.lastBlockInsertAt).toBe("2026-01-01T00:00:00.000Z");
    expect(db.observability?.lastStatusFetchAt).toBe(new Date(1_800_000_000_000).toISOString());
  });
});

describe("runTipLoop", () => {
  it("surfaces AuthError to the caller so cleanup can run", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) return { status: 401 };
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await expect(
      runTipLoop(
        { config: makeConfig({ once: true }), client, db, state },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("rethrows RateLimitError from a 429 in --once mode", async () => {
    // Exponential-backoff behavior between retries isn't easily unit-tested
    // from the outside without faking setTimeout; --once mode is where the
    // caller cares about the thrown class (so they can surface exit code 1).
    // Abort the signal on the first 429 so sleepInterruptible returns
    // immediately, keeping the test fast.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const controller = new AbortController();
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) {
        controller.abort();
        return { status: 429 };
      }
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await expect(
      runTipLoop({ config: makeConfig({ once: true }), client, db, state }, controller.signal),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("propagates iteration errors in --once mode as a rejection", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/v1/telemetry/status")) return { status: 500 };
      return { status: 404 };
    });
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await expect(
      runTipLoop(
        { config: makeConfig({ once: true }), client, db, state },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/500/);
  });
});
