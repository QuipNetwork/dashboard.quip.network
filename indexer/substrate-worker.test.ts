// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteAdapter } from "../api/db/sqlite";
import type { BlockRecord } from "../src/types/telemetry";

import { FakeSubstrateClient } from "./substrate-client";
import { IndexerState } from "./state";
import { runSubstrateLoop } from "./substrate-worker";
import { makeConfig } from "./test-helpers";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sampleBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    epoch: "abc123",
    blockIndex: 1,
    blockHash: "0xpow",
    timestamp: 1_700_000_000,
    previousHash: "0x0",
    minerId: "M",
    minerCategory: "CPU",
    ecdsaPublicKey: "k",
    energy: 12.5,
    diversity: 0.5,
    numValidSolutions: 3,
    miningTime: 1.0,
    nonce: "0",
    numNodes: 1,
    numEdges: 0,
    difficultyEnergy: 10,
    minDiversity: 0.3,
    minSolutions: 1,
    substrateBlockNumber: null,
    substrateBlockHash: null,
    substrateParentHash: null,
    extrinsicsRoot: null,
    stateRoot: null,
    finalized: false,
    isCanonical: true,
    ...overrides,
  };
}

let dir: string;
let db: SQLiteAdapter;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "quip-substrate-"));
  db = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: join(dir, "telemetry.db") });
  await db.connect();
  await db.migrate();
});

afterEach(async () => {
  await db.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("substrate worker", () => {
  test("on finalized head, writes chain_head and updates observability heartbeat", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateRpcUrl: "ws://x", substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        client,
        db,
        state,
        chainHeadDebounceMs: 0,
        now: () => Date.parse("2026-05-15T00:00:00.000Z"),
      },
      ac.signal,
    );

    // Worker calls client.connect() internally; wait for subscriptions to
    // settle. Bun's setTimeout scheduling needs ≥50ms to reliably fire the
    // 0ms chain_head debounce after our emit, so this also gives the
    // worker's three-step await chain time to complete.
    await wait(50);
    client.emitFinalized({
      number: "100",
      hash: "0xab",
      parentHash: "0xaa",
      extrinsicsRoot: "0xee",
      stateRoot: "0xff",
    });
    await wait(100);
    // Snapshot connection state before tearing down — the worker's
    // finally block flips chainConnected=false on abort, which is
    // semantically correct (a torn-down worker is not connected).
    expect(state.observability.chainConnected).toBe(true);
    ac.abort();
    await loop;

    const head = await db.getChainHead();
    expect(head?.finalizedBlockNumber).toBe("100");
    expect(head?.finalizedBlockHash).toBe("0xab");
    expect(state.observability.lastSubstrateEventAt).toBe("2026-05-15T00:00:00.000Z");
    expect(state.observability.finalizedBlockHeight).toBe("100");
  });

  test("BlockWinner event enriches the matching block via getBlockHeader lookup", async () => {
    await db.insertBlock(sampleBlock());
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.setHeader({
      number: "42",
      hash: "0xsub",
      parentHash: "0xsubp",
      extrinsicsRoot: "0xexr",
      stateRoot: "0xstr",
    });

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateRpcUrl: "ws://x", substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    client.emitBlockWinner({
      miner: "M",
      reward: "1000",
      energyMilli: 12500,
      submittedAt: "42",
    });
    await wait(100);
    ac.abort();
    await loop;

    const blocks = await db.getBlocksByEpoch("abc123");
    expect(blocks[0]?.substrateBlockNumber).toBe("42");
    expect(blocks[0]?.substrateBlockHash).toBe("0xsub");
    expect(blocks[0]?.extrinsicsRoot).toBe("0xexr");
    expect(blocks[0]?.stateRoot).toBe("0xstr");
  });

  test("BlockWinner event with no matching PoW block buffers in pendingWinnerEvents", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.setHeader({
      number: "7",
      hash: "0xs7",
      parentHash: "0xs6",
      extrinsicsRoot: "0xer",
      stateRoot: "0xsr",
    });

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateRpcUrl: "ws://x", substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    client.emitBlockWinner({
      miner: "M-unknown",
      reward: "1000",
      energyMilli: 99000,
      submittedAt: "7",
    });
    await wait(100);
    ac.abort();
    await loop;

    expect(state.pendingWinnerEvents.size).toBe(1);
    const buffered = state.pendingWinnerEvents.get("M-unknown:99");
    expect(buffered?.submittedAt).toBe("7");
    expect(buffered?.substrateBlockHash).toBe("0xs7");
  });

  test("finalized head marks blocks <= finalizedNumber as finalized", async () => {
    await db.insertBlock(sampleBlock({ epoch: "e1", blockIndex: 1, minerId: "X", energy: 1 }));
    await db.insertBlock(sampleBlock({ epoch: "e1", blockIndex: 2, minerId: "Y", energy: 2 }));
    await db.updateBlockSubstrateFields("e1", 1, { substrateBlockNumber: "10" });
    await db.updateBlockSubstrateFields("e1", 2, { substrateBlockNumber: "20" });

    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateRpcUrl: "ws://x", substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    client.emitFinalized({
      number: "15",
      hash: "0xf",
      parentHash: "0xfp",
      extrinsicsRoot: "0xfe",
      stateRoot: "0xfs",
    });
    await wait(100);
    ac.abort();
    await loop;

    const blocks = await db.getBlocksByEpoch("e1");
    const b1 = blocks.find((b) => b.blockIndex === 1);
    const b2 = blocks.find((b) => b.blockIndex === 2);
    expect(b1?.finalized).toBe(true); // substrate_block_number 10 <= 15
    expect(b2?.finalized).toBe(false); // substrate_block_number 20 > 15
  });

  test("disconnect flips chainConnected to false", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateRpcUrl: "ws://x", substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    expect(state.observability.chainConnected).toBe(true);
    await client.disconnect();
    await wait(50);
    expect(state.observability.chainConnected).toBe(false);
    ac.abort();
    await loop;
  });

  test("pendingWinnerEvents drops oldest on overflow", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.setHeader({
      number: "1",
      hash: "0xh",
      parentHash: "0xp",
      extrinsicsRoot: "0xe",
      stateRoot: "0xs",
    });

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateRpcUrl: "ws://x", substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    // Emit 300 events; only 256 should remain (LRU eviction).
    for (let i = 0; i < 300; i++) {
      client.emitBlockWinner({
        miner: `miner-${i}`,
        reward: "0",
        energyMilli: 1000,
        submittedAt: "1",
      });
    }
    await wait(100);
    ac.abort();
    await loop;

    expect(state.pendingWinnerEvents.size).toBe(IndexerState.PENDING_WINNER_LIMIT);
    // Earliest entries should have been evicted; verify miner-0 is gone but
    // miner-299 (most recent) is present.
    expect(state.pendingWinnerEvents.has("miner-0:1")).toBe(false);
    expect(state.pendingWinnerEvents.has("miner-299:1")).toBe(true);
  });
});
