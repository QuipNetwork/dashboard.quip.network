// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type {
  BlockRecord,
  IndexerCursor,
  NodesSnapshot,
  TelemetryIndex,
} from "../src/types/telemetry";
import type { DatabaseAdapter } from "../api/db/adapter";

import { AuthError, QuipClient, RateLimitError } from "./client";
import type { IndexerConfig } from "./config";
import { runIteration, runLoop } from "./loop";
import { IndexerState } from "./state";

class FakeDb implements DatabaseAdapter {
  connected = false;
  migrated = false;
  inserted: BlockRecord[] = [];
  upserted: NodesSnapshot[] = [];
  savedCursors: Array<{
    cursor: IndexerCursor;
    etags: { nodes?: string | null };
  }> = [];
  cursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  etags: { nodes: string | null } = { nodes: null };
  selfAddress: string | null = null;

  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async migrate() {
    this.migrated = true;
  }

  async insertBlock(b: BlockRecord): Promise<boolean> {
    this.inserted.push(b);
    return true;
  }
  async getAllBlocks(): Promise<BlockRecord[]> {
    return [...this.inserted];
  }
  async getBlocksByEpoch(epoch: number): Promise<BlockRecord[]> {
    return this.inserted.filter((b) => b.epoch === epoch);
  }
  async getIndex(): Promise<TelemetryIndex> {
    return { epochs: [], lastUpdated: new Date().toISOString() };
  }

  async upsertNodes(snapshot: NodesSnapshot): Promise<number> {
    this.upserted.push(snapshot);
    return Object.keys(snapshot.nodes).length;
  }
  async getNodes(): Promise<NodesSnapshot | null> {
    return this.upserted.at(-1) ?? null;
  }

  async getCursor(): Promise<IndexerCursor> {
    return { ...this.cursor };
  }
  async saveCursor(cursor: IndexerCursor, etags: { nodes?: string | null }): Promise<void> {
    this.savedCursors.push({ cursor: { ...cursor }, etags: { ...etags } });
    this.cursor = { ...cursor };
    if (etags.nodes !== undefined) this.etags.nodes = etags.nodes ?? null;
  }
  async getEtags() {
    return { ...this.etags };
  }

  async getSelfAddress(): Promise<string | null> {
    return this.selfAddress;
  }
  async setSelfAddress(address: string | null): Promise<void> {
    this.selfAddress = address;
  }
}

interface FakeResponseSpec {
  status: number;
  etag?: string | null;
  body?: unknown;
  // raw body text that bypasses JSON.stringify (used to inject big-int literals)
  rawText?: string;
}

type Router = (url: string, init: RequestInit | undefined) => FakeResponseSpec;

function makeFetch(router: Router): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const spec = router(url, init);
    const text =
      spec.rawText !== undefined
        ? spec.rawText
        : spec.body !== undefined
          ? JSON.stringify({ success: true, data: spec.body })
          : "";
    const headers = new Headers();
    if (spec.etag) headers.set("etag", spec.etag);
    const res = new Response(spec.status === 304 ? null : text, {
      status: spec.status,
      headers,
    });
    // jsdom/undici responses normally expose url, but fetch()'s Response
    // doesn't carry it; we stash it so error messages in the client show
    // something useful. Not strictly required for tests.
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return res;
  };
  return fn as typeof fetch;
}

function makeConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    nodeUrl: "https://node.example.com",
    token: undefined,
    pollIntervalSec: 8,
    nodesRefreshSec: 45,
    backfillFromEpoch: undefined,
    once: false,
    verbose: false,
    ...overrides,
  };
}

function buildBlockPayload(
  epoch: number,
  index: number,
  nonce: number | string = 123,
): Record<string, unknown> {
  return {
    block_index: index,
    block_hash: `hash-${epoch}-${index}`,
    timestamp: 1_700_000_000 + index,
    previous_hash: `prev-${index}`,
    miner: {
      miner_id: "miner-a",
      miner_type: "QPU",
      ecdsa_public_key: "pk",
    },
    quantum_proof: {
      energy: -1.5,
      diversity: 0.5,
      num_valid_solutions: 2,
      mining_time: 3.14,
      nonce,
      num_nodes: 4,
      num_edges: 5,
    },
    requirements: {
      difficulty_energy: -2.0,
      min_diversity: 0.1,
      min_solutions: 1,
    },
  };
}

function statusBody(
  latestEpoch: string,
  latestBlockIndex: number,
  totalBlocks = latestBlockIndex,
): Record<string, unknown> {
  return {
    epochs: [latestEpoch],
    latest_epoch: latestEpoch,
    latest_block_index: latestBlockIndex,
    total_blocks: totalBlocks,
    node_count: 0,
    active_node_count: 0,
    nodes_updated_at: null,
  };
}

describe("runIteration", () => {
  it("indexes all pending blocks on fresh boot", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "1000:3:3", body: statusBody("1000", 3) };
      }
      const m = url.match(/\/epochs\/(\d+)\/blocks\/(\d+)$/);
      if (m) {
        return { status: 200, body: buildBlockPayload(Number(m[1]), Number(m[2])) };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig(), client, db, state, now: () => 0 },
      { value: 0 },
    );

    expect(r.fetchedStatus).toBe(true);
    expect(r.blocksIndexed).toBe(3);
    expect(db.inserted).toHaveLength(3);
    expect(db.inserted.map((b) => b.blockIndex)).toEqual([1, 2, 3]);
    expect(state.cursor).toEqual({ epoch: 1000, blockIndex: 3 });
    expect(db.savedCursors.at(-1)?.cursor).toEqual({
      epoch: 1000,
      blockIndex: 3,
    });
  });

  it("no-ops on a 304 status response", async () => {
    // Defensive: /status is now fetched without If-None-Match, so a 304 here
    // is unusual — but the handler should still fail closed and not try any
    // block fetches without a body.
    const db = new FakeDb();
    db.cursor = { epoch: 1000, blockIndex: 2 };
    const state = new IndexerState(db);
    await state.load();

    let blockFetches = 0;
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) return { status: 304 };
      if (/\/blocks\//.test(url)) {
        blockFetches += 1;
        return { status: 200, body: {} };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig(), client, db, state, now: () => 0 },
      { value: Date.now() },
    );

    expect(r.fetchedStatus).toBe(true);
    expect(r.blocksIndexed).toBe(0);
    expect(blockFetches).toBe(0);
    expect(db.inserted).toHaveLength(0);
  });

  it("advances cursor to the next known epoch once the current one is drained", async () => {
    // With backfill-always-on, an epoch transition no longer means "reset to
    // tip"; the cursor walks forward through the epoch list one epoch per
    // iteration. First iteration finishes epoch 1000 and advances.
    const db = new FakeDb();
    db.cursor = { epoch: 1000, blockIndex: 5 };
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "2000:2:2", body: statusBody("2000", 2) };
      }
      if (url.endsWith("/epochs")) {
        return {
          status: 200,
          body: {
            epochs: [
              { epoch: 1000, block_count: 5, first_block: 1, last_block: 5 },
              { epoch: 2000, block_count: 2, first_block: 1, last_block: 2 },
            ],
          },
        };
      }
      const m = url.match(/\/epochs\/(\d+)\/blocks\/(\d+)$/);
      if (m) {
        return { status: 200, body: buildBlockPayload(Number(m[1]), Number(m[2])) };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig(), client, db, state, now: () => 0 },
      { value: 0 },
    );

    expect(r.blocksIndexed).toBe(0);
    expect(state.cursor).toEqual({ epoch: 2000, blockIndex: 0 });
  });

  it("preserves big-int nonce as an exact string", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const nonceDigits = "14191405648832262461";
    // Raw JSON envelope with a bare integer nonce (above 2^53).
    const rawBlockJson = JSON.stringify({
      success: true,
      data: buildBlockPayload(1000, 1, 0),
    }).replace(/"nonce":0/, `"nonce":${nonceDigits}`);

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "1000:1:1", body: statusBody("1000", 1) };
      }
      if (/\/blocks\/1$/.test(url)) {
        return { status: 200, rawText: rawBlockJson };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await runIteration({ config: makeConfig(), client, db, state, now: () => 0 }, { value: 0 });

    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]!.nonce).toBe(nonceDigits);
  });

  it("advances cursor and skips on 404 blocks", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "1000:2:2", body: statusBody("1000", 2) };
      }
      if (/\/blocks\/1$/.test(url)) return { status: 404 };
      if (/\/blocks\/2$/.test(url)) {
        return { status: 200, body: buildBlockPayload(1000, 2) };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig(), client, db, state, now: () => 0 },
      { value: 0 },
    );

    expect(r.blocksIndexed).toBe(1);
    expect(r.blocksSkipped).toBe(1);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]!.blockIndex).toBe(2);
    expect(state.cursor).toEqual({ epoch: 1000, blockIndex: 2 });
  });

  it("rethrows RateLimitError from getBlock and persists cursor at last successful insert", async () => {
    // Without this, block-level 429s got swallowed by `break` and never
    // reached runLoop's exponential backoff — the indexer just retried every
    // pollIntervalSec and hammered the upstream.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "1000:5:5", body: statusBody("1000", 5) };
      }
      if (/\/blocks\/3$/.test(url)) return { status: 429 };
      const m = url.match(/\/epochs\/(\d+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(Number(m[1]), Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await expect(
      runIteration({ config: makeConfig(), client, db, state, now: () => 0 }, { value: 0 }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(db.inserted.map((b) => b.blockIndex)).toEqual([1, 2]);
    expect(db.savedCursors.at(-1)?.cursor).toEqual({ epoch: 1000, blockIndex: 2 });
  });

  it("throws and persists cursor up to last successful insert on db error", async () => {
    const db = new FakeDb();
    // Fail on the 2nd insert.
    let inserts = 0;
    db.insertBlock = async (b: BlockRecord): Promise<boolean> => {
      inserts += 1;
      if (inserts === 2) throw new Error("simulated db write error");
      db.inserted.push(b);
      return true;
    };
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "1000:3:3", body: statusBody("1000", 3) };
      }
      const m = url.match(/\/epochs\/(\d+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(Number(m[1]), Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await expect(
      runIteration({ config: makeConfig(), client, db, state, now: () => 0 }, { value: 0 }),
    ).rejects.toThrow(/simulated db write error/);

    // Block 1 was inserted before the failure on block 2.
    expect(db.inserted).toHaveLength(1);
    // Cursor was persisted at the last successful insert so the next
    // iteration resumes from block 2, not block 1.
    expect(db.savedCursors.at(-1)?.cursor).toEqual({ epoch: 1000, blockIndex: 1 });
  });
});

describe("runIteration self-address", () => {
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

    await runIteration(
      { config: makeConfig({ nodesRefreshSec: 0 }), client, db, state, now: () => 0 },
      { value: -1_000_000 },
    );

    expect(db.selfAddress).toBe("node.example.com:20049");
  });

  it("leaves the address null when the node reports a host missing from the snapshot", async () => {
    // Stale snapshot edge case: node advertises itself but the snapshot
    // doesn't yet include it.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch(
      nodesRouter("node.example.com:20049", {
        "other.example.com:20049": baseNode({ address: "other.example.com:20049" }),
      }),
    );
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await runIteration(
      { config: makeConfig({ nodesRefreshSec: 0 }), client, db, state, now: () => 0 },
      { value: -1_000_000 },
    );

    expect(db.selfAddress).toBeNull();
  });

  it("leaves the address null when the node lacks /api/v1/status (older version)", async () => {
    // Older node versions without /api/v1/status — getSelfHost returns null
    // and there is no fallback. Operator would need to upgrade the node.
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch(
      nodesRouter(null, {
        "node.example.com:20049": baseNode({ address: "node.example.com:20049" }),
      }),
    );
    const client = new QuipClient({ baseUrl: "https://node.example.com", fetchImpl });

    await runIteration(
      { config: makeConfig({ nodesRefreshSec: 0 }), client, db, state, now: () => 0 },
      { value: -1_000_000 },
    );

    expect(db.selfAddress).toBeNull();
  });
});

describe("runIteration backfill", () => {
  it("backfills an older epoch and advances to the next one on completion", async () => {
    const db = new FakeDb();
    // Simulate cursor already sitting in an older epoch mid-backfill.
    db.cursor = { epoch: 900, blockIndex: 0 };
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "1000:5:10", body: statusBody("1000", 5, 10) };
      }
      if (url.endsWith("/epochs")) {
        return {
          status: 200,
          body: {
            epochs: [
              { epoch: 900, block_count: 2, first_block: 1, last_block: 2 },
              { epoch: 1000, block_count: 5, first_block: 1, last_block: 5 },
            ],
          },
        };
      }
      const m = url.match(/\/epochs\/(\d+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(Number(m[1]), Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig({ backfillFromEpoch: 900 }), client, db, state, now: () => 0 },
      { value: 0 },
    );

    // Indexed both blocks of epoch 900, then advanced cursor directly to the
    // next known epoch 1000 — not 901, which doesn't exist in /epochs.
    expect(r.blocksIndexed).toBe(2);
    expect(db.inserted.map((b) => [b.epoch, b.blockIndex])).toEqual([
      [900, 1],
      [900, 2],
    ]);
    expect(state.cursor).toEqual({ epoch: 1000, blockIndex: 0 });
  });

  it("does NOT skip old epochs when backfill is configured", async () => {
    // Regression guard: before the fix, once cursor.epoch was persisted the
    // loop would reset to status.latestEpoch on the next iteration, dropping
    // everything between backfillFromEpoch and latestEpoch. With the fix the
    // cursor walks known epochs in order until it catches up to latestEpoch.
    const db = new FakeDb();
    db.cursor = { epoch: 900, blockIndex: 2 }; // epoch 900 already drained
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "e", body: statusBody("1000", 1, 10) };
      }
      if (url.endsWith("/epochs")) {
        return {
          status: 200,
          body: {
            epochs: [
              { epoch: 900, block_count: 2, first_block: 1, last_block: 2 },
              { epoch: 901, block_count: 3, first_block: 1, last_block: 3 },
              { epoch: 1000, block_count: 1, first_block: 1, last_block: 1 },
            ],
          },
        };
      }
      const m = url.match(/\/epochs\/(\d+)\/blocks\/(\d+)$/);
      if (m) return { status: 200, body: buildBlockPayload(Number(m[1]), Number(m[2])) };
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await runIteration(
      { config: makeConfig({ backfillFromEpoch: 900 }), client, db, state, now: () => 0 },
      { value: 0 },
    );

    // Without backfill-awareness, cursor would have jumped straight to 1000.
    // With the fix, it advances to 901 — the next known epoch.
    expect(state.cursor).toEqual({ epoch: 901, blockIndex: 0 });
  });

  it("jumps directly to next known epoch when cursor lands in a gap", async () => {
    // Regression guard: epoch numbers are timestamps with arbitrary gaps.
    // A cursor + 1 walk takes thousands of no-op iterations per hop; the
    // /epochs list is authoritative and already fetched in this path.
    const db = new FakeDb();
    db.cursor = { epoch: 910, blockIndex: 0 }; // 910 is not in /epochs
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "e", body: statusBody("1000", 1) };
      }
      if (url.endsWith("/epochs")) {
        return {
          status: 200,
          body: {
            epochs: [
              { epoch: 900, block_count: 2, first_block: 1, last_block: 2 },
              { epoch: 1000, block_count: 1, first_block: 1, last_block: 1 },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig({ backfillFromEpoch: 900 }), client, db, state, now: () => 0 },
      { value: 0 },
    );

    expect(r.blocksIndexed).toBe(0);
    expect(state.cursor).toEqual({ epoch: 1000, blockIndex: 0 });
  });

  it("waits when cursor is past the last known epoch", async () => {
    // No newer epoch exists in /epochs. Don't advance — wait for the chain.
    const db = new FakeDb();
    db.cursor = { epoch: 1100, blockIndex: 0 };
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        return { status: 200, etag: "e", body: statusBody("1200", 1) };
      }
      if (url.endsWith("/epochs")) {
        return {
          status: 200,
          body: {
            epochs: [{ epoch: 1000, block_count: 1, first_block: 1, last_block: 1 }],
          },
        };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const r = await runIteration(
      { config: makeConfig({ backfillFromEpoch: 900 }), client, db, state, now: () => 0 },
      { value: 0 },
    );

    expect(r.blocksIndexed).toBe(0);
    // Cursor stays put — we'll re-check on the next iteration.
    expect(state.cursor).toEqual({ epoch: 1100, blockIndex: 0 });
  });
});

describe("runLoop", () => {
  it("surfaces AuthError to the caller so cleanup can run", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) return { status: 401 };
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await expect(
      runLoop(
        { config: makeConfig({ once: true }), client, db, state, sleep: async () => {} },
        () => false,
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("applies exponential backoff on repeated 429s and resets after success", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    let statusCalls = 0;
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) {
        statusCalls += 1;
        // First 3 responses are 429, then a success.
        if (statusCalls <= 3) return { status: 429 };
        return { status: 200, etag: "e", body: statusBody("1000", 0) };
      }
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };

    // Stop once we've observed the successful iteration after 3 backoffs.
    let done = false;
    await runLoop({ config: makeConfig({ pollIntervalSec: 1 }), client, db, state, sleep }, () => {
      if (statusCalls >= 4) done = true;
      return done;
    });

    // First three sleeps are the 429 backoffs: 5s → 10s → 20s.
    expect(sleeps.slice(0, 3)).toEqual([5000, 10000, 20000]);
    expect(statusCalls).toBeGreaterThanOrEqual(4);
  });

  it("propagates iteration errors in --once mode as a rejection", async () => {
    const db = new FakeDb();
    const state = new IndexerState(db);
    await state.load();

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/status")) return { status: 500 };
      return { status: 404 };
    });
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await expect(
      runLoop(
        { config: makeConfig({ once: true }), client, db, state, sleep: async () => {} },
        () => false,
      ),
    ).rejects.toThrow(/500/);
  });
});

describe("QuipClient error handling", () => {
  it("throws when the envelope reports success:false", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      rawText: JSON.stringify({ success: false, error: "internal error" }),
    }));
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await expect(client.getStatus(null)).rejects.toThrow(/internal error/);
  });

  it("throws when a block response has a non-numeric nonce string", async () => {
    // If the upstream API ever hands us a nonce that's already a non-numeric
    // string, the regex pre-pass won't touch it and the raw value lands in
    // the parsed payload. assertNonceShape should refuse to ingest it rather
    // than letting a bad row reach the DB.
    const payload = buildBlockPayload(1000, 1, "abc");
    const rawBlockJson = JSON.stringify({ success: true, data: payload });

    const fetchImpl = makeFetch(() => ({ status: 200, rawText: rawBlockJson }));
    const client = new QuipClient({
      baseUrl: "https://node.example.com",
      fetchImpl,
    });

    await expect(client.getBlock(1000, 1)).rejects.toThrow(/malformed nonce/);
  });
});
