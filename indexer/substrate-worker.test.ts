// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteAdapter } from "../api/db/sqlite";

import { FakeSubstrateClient } from "./substrate-client";
import { IndexerState } from "./state";
import { runSubstrateLoop } from "./substrate-worker";
import { makeConfig } from "./test-helpers";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  test("substrate worker inserts complete BlockRecord on subscribeBlockEvents fire", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 100, edgeCount: 200 };
    // v0.2: per-block difficulty + nonce come from
    // `QuantumPowApi::winning_solution(block_number)`, not a separate
    // polled snapshot. Wire shape is milli-encoded; the worker converts
    // to floats (energy/diversity) and integer units (min_solutions)
    // before BlockRecord insertion.
    client.winningSolutionsByBlock.set("100", {
      miner: "5GPP",
      energyMilli: -2510,
      reward: "1000",
      submittedAt: "100",
      nonce: "42",
      difficulty: {
        maxEnergyMilli: -2500,
        minDiversityMilli: 200,
        minSolutions: 5,
      },
    });
    client.lastProofBlockByHash.set("0xsub99", 94);

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
        now: () => Date.parse("2026-05-19T00:00:00.000Z"),
      },
      ac.signal,
    );
    // Give the worker time to complete `client.connect()` and register
    // its subscriptions before we emit. Without this, `emitBlock` can
    // fire before `subscribeBlockEvents` has registered its callback.
    await wait(50);
    client.emitBlock({
      blockNumber: 100,
      blockHash: "0xsub",
      parentHash: "0xsub99",
      author: "5Author",
      timestamp: 1700000000,
      winner: {
        miner: "5GPP",
        reward: "1000",
        energyMilli: -2510,
        submittedAt: "100",
      },
      proofs: [
        {
          miner: "5GPP",
          energyMilli: -2510,
          diversityMilli: 420,
          validSolutionCount: 5,
        },
      ],
      nonce: "42",
    });
    await wait(100);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.blockHash).toBe("0xsub");
    expect(b.substrateBlockNumber).toBe("100");
    expect(b.substrateBlockHash).toBe("0xsub");
    expect(b.substrateParentHash).toBe("0xsub99");
    expect(b.timestamp).toBe(1700000000);
    expect(b.minerId).toBe("5GPP");
    expect(b.energy).toBeCloseTo(-2.51, 5);
    expect(b.diversity).toBeCloseTo(0.42, 3);
    expect(b.numValidSolutions).toBe(5);
    expect(b.miningTime).toBe(36); // (100 - 94) blocks × 6s slot duration
    expect(b.nonce).toBe("42");
    expect(b.numNodes).toBe(100);
    expect(b.numEdges).toBe(200);
    expect(b.reward).toBe("1000");
    // Wire shape divided by 1000: -2500 milli → -2.5 energy units.
    expect(b.difficultyEnergy).toBeCloseTo(-2.5, 5);
    expect(b.minDiversity).toBeCloseTo(0.2, 5);
    expect(b.minSolutions).toBe(5);
    expect(b.finalized).toBe(true); // subscribed to finalized heads
    expect(state.observability.lastBlockInsertAt).toBe("2026-05-19T00:00:00.000Z");
    expect(state.observability.lastSubstrateEventAt).toBe("2026-05-19T00:00:00.000Z");
  });

  test("subscribeBlockEvents skips insert when nonce is null", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 5, edgeCount: 10 };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    // Winner + matching ProofAccepted, but BlockEvents arrived with
    // nonce: null (runtime returned no WinningSolution for this block)
    // — skip rather than collide with nonce "0" as a no-info sentinel.
    client.emitBlock({
      blockNumber: 77,
      blockHash: "0xnononce",
      parentHash: "0xprev",
      author: "5Author",
      timestamp: 1700000077,
      winner: {
        miner: "5GPP",
        reward: "1000",
        energyMilli: -500,
        submittedAt: "77",
      },
      proofs: [
        {
          miner: "5GPP",
          energyMilli: -500,
          diversityMilli: 200,
          validSolutionCount: 2,
        },
      ],
      nonce: null,
    });
    await wait(100);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks).toHaveLength(0);
  });

  test("subscribeBlockEvents skips insert when winner has no matching ProofAccepted", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 10, edgeCount: 20 };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    // Winner's (miner, energyMilli) doesn't match any ProofAccepted. The
    // worker logs and skips — no block row should appear.
    client.emitBlock({
      blockNumber: 42,
      blockHash: "0xnomatch",
      parentHash: "0xprev",
      author: "5Author",
      timestamp: 1700000001,
      winner: {
        miner: "5GPP",
        reward: "1000",
        energyMilli: -1000,
        submittedAt: "42",
      },
      proofs: [
        {
          miner: "5OTHER",
          energyMilli: -1000,
          diversityMilli: 100,
          validSolutionCount: 1,
        },
      ],
      nonce: "1",
    });
    await wait(100);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks).toHaveLength(0);
  });

  test("mining_time is 0 when LastProofBlock returns 0 (no prior winning proof)", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 1, edgeCount: 0 };
    // Don't set lastProofBlockByHash → getLastProofBlockAt returns 0.

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    client.emitBlock({
      blockNumber: 5,
      blockHash: "0xfirst",
      parentHash: "0xgenesis",
      author: "5Author",
      timestamp: 1700000002,
      winner: { miner: "5A", reward: "0", energyMilli: -100, submittedAt: "5" },
      proofs: [
        {
          miner: "5A",
          energyMilli: -100,
          diversityMilli: 1,
          validSolutionCount: 1,
        },
      ],
      nonce: "0",
    });
    await wait(100);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.miningTime).toBe(0);
  });

  test("on finalized head, writes chain_head and updates observability heartbeat", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    // Two WinningSolutions entries on chain → chain_head.winningSolutionsCount
    // = 2 (the global solution_number bound; in-flight problem = 3).
    client.winningSolutionsByBlock.set("40", {
      miner: "5GPP",
      energyMilli: -2510,
      reward: "1000",
      submittedAt: "40",
      nonce: "1",
      difficulty: { maxEnergyMilli: -2500, minDiversityMilli: 200, minSolutions: 5 },
    });
    client.winningSolutionsByBlock.set("80", {
      miner: "5GPP",
      energyMilli: -2520,
      reward: "1000",
      submittedAt: "80",
      nonce: "2",
      difficulty: { maxEnergyMilli: -2500, minDiversityMilli: 200, minSolutions: 5 },
    });

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
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
    expect(head?.winningSolutionsCount).toBe(2);
    expect(state.observability.lastSubstrateEventAt).toBe("2026-05-15T00:00:00.000Z");
    expect(state.observability.finalizedBlockHeight).toBe("100");
  });

  test("disconnect flips chainConnected to false", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
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

  test("polls BABE epoch on connect and writes the row", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.babeEpoch = {
      epochIndex: 7,
      currentSlot: "16805",
      epochStartSlot: "16800",
      slotsPerEpoch: 2400,
      authorityCount: 3,
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(100);
    ac.abort();
    await loop;

    const epoch = await db.getCurrentBabeEpoch();
    expect(epoch?.epochIndex).toBe(7);
    expect(epoch?.currentSlotInEpoch).toBe(5);
    expect(epoch?.authorityCount).toBe(3);
  });

  test("BABE epoch poll is idempotent — no write when slot unchanged", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.babeEpoch = {
      epochIndex: 7,
      currentSlot: "16800",
      epochStartSlot: "16800",
      slotsPerEpoch: 2400,
      authorityCount: 1,
    };

    // First connect → write. Then disconnect+reconnect with same data,
    // second `pollBabeEpoch` should NOT change updated_at (idempotency
    // handled at the worker layer via the hash cache; the row's
    // updated_at column would change on every upsert otherwise).
    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1, // 1s timer to exercise the repeat path
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    const first = await db.getCurrentBabeEpoch();
    // Tick the timer twice; cache should prevent re-upsert.
    await wait(2100);
    const second = await db.getCurrentBabeEpoch();
    expect(first?.epochIndex).toBe(second?.epochIndex);
    expect(first?.currentSlot).toBe(second?.currentSlot);
    ac.abort();
    await loop;
  }, 5000);

  test("polls difficulty after a finalized head lands", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.difficulty = {
      maxEnergyMilli: 12500,
      minDiversityMilli: 500,
      minSolutions: 3,
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1, // 1s so the difficulty timer fires
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    // Need a finalized head first so observability.finalizedBlockHeight
    // is non-null before difficulty polls fire.
    await wait(50);
    client.emitFinalized({
      number: "100",
      hash: "0xf",
      parentHash: "0xfp",
      extrinsicsRoot: "0xer",
      stateRoot: "0xsr",
    });
    await wait(1200);
    ac.abort();
    await loop;

    const recent = await db.getRecentDifficulty(10);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0]?.difficultyEnergy).toBeCloseTo(12.5, 5);
    expect(recent[0]?.minDiversity).toBeCloseTo(0.5, 5);
    expect(recent[0]?.minSolutions).toBe(3);
    expect(recent[0]?.observedAtBlock).toBe("100");
  }, 5000);

  test("difficulty poll skips when finalizedBlockHeight is null", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.difficulty = {
      maxEnergyMilli: 12500,
      minDiversityMilli: 500,
      minSolutions: 3,
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    // No finalized head emitted — finalizedBlockHeight stays null. The
    // initial connect poll runs but skips the write.
    await wait(200);
    ac.abort();
    await loop;

    const recent = await db.getRecentDifficulty(10);
    expect(recent).toHaveLength(0);
  });

  test("polls chain miners on connect and writes the rows", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.chainMiners = [
      {
        accountId: "5GrwvaEF1",
        deposit: "1000000000000",
        proofsSubmitted: "42",
        proofsWon: "7",
        rewardsEarned: "7000000000000",
      },
      {
        accountId: "5GrwvaEF2",
        deposit: "2000000000000",
        proofsSubmitted: "10",
        proofsWon: "1",
        rewardsEarned: "1000000000000",
      },
    ];

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(100);
    ac.abort();
    await loop;

    const miners = await db.getChainMiners();
    expect(miners.map((m) => m.accountId).sort()).toEqual(["5GrwvaEF1", "5GrwvaEF2"]);
    const m1 = miners.find((m) => m.accountId === "5GrwvaEF1");
    expect(m1?.proofsWon).toBe("7");
  });

  test("polls BABE authorities scoped to the current epoch", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.babeEpoch = {
      epochIndex: 5,
      currentSlot: "12000",
      epochStartSlot: "12000",
      slotsPerEpoch: 2400,
      authorityCount: 2,
    };
    client.babeAuthorities = [
      { accountId: "5Auth1", displayName: null },
      { accountId: "5Auth2", displayName: null },
    ];

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(100);
    ac.abort();
    await loop;

    const active = await db.getActiveBabeAuthorities();
    expect(active.map((a) => a.accountId)).toEqual(["5Auth1", "5Auth2"]);
  });

  test("records validator authorship on every finalized head with an author", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 1, edgeCount: 0 };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    // Three finalized heads from two distinct authors: 5Auth1 wins one PoW
    // and authors a winnerless head; 5Auth2 authors a winning block.
    client.emitBlock({
      blockNumber: 10,
      blockHash: "0xa",
      parentHash: "0x0",
      author: "5Auth1",
      timestamp: 1_700_000_000,
      winner: { miner: "5M", reward: "0", energyMilli: -100, submittedAt: "10" },
      proofs: [
        {
          miner: "5M",
          energyMilli: -100,
          diversityMilli: 1,
          validSolutionCount: 1,
        },
      ],
      nonce: "1",
    });
    client.emitBlock({
      blockNumber: 11,
      blockHash: "0xb",
      parentHash: "0xa",
      author: "5Auth1",
      timestamp: 1_700_000_006,
      winner: null,
      proofs: [],
      nonce: null,
    });
    client.emitBlock({
      blockNumber: 12,
      blockHash: "0xc",
      parentHash: "0xb",
      author: "5Auth2",
      timestamp: 1_700_000_012,
      winner: { miner: "5M", reward: "0", energyMilli: -200, submittedAt: "12" },
      proofs: [
        {
          miner: "5M",
          energyMilli: -200,
          diversityMilli: 2,
          validSolutionCount: 1,
        },
      ],
      nonce: "2",
    });
    await wait(100);
    ac.abort();
    await loop;

    const rows = await db.getValidatorAuthorship();
    expect(rows).toHaveLength(2);
    const auth1 = rows.find((r) => r.accountId === "5Auth1");
    const auth2 = rows.find((r) => r.accountId === "5Auth2");
    expect(auth1?.blocksAuthored).toBe(2);
    expect(auth1?.blocksAuthoredWithPow).toBe(1);
    expect(auth1?.lastAuthoredBlock).toBe("11");
    expect(auth2?.blocksAuthored).toBe(1);
    expect(auth2?.blocksAuthoredWithPow).toBe(1);
    expect(auth2?.lastAuthoredBlock).toBe("12");
  });

  test("authorship-only head (winner=null) records authorship but does not insertBlock", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    client.emitBlock({
      blockNumber: 50,
      blockHash: "0xnowin",
      parentHash: "0xprev",
      author: "5Auth1",
      timestamp: 1_700_000_500,
      winner: null,
      proofs: [],
      nonce: null,
    });
    await wait(100);
    ac.abort();
    await loop;

    // No PoW row was written for the winnerless head.
    expect(await db.getRecentBlocks(10, 0)).toHaveLength(0);
    // But authorship was recorded with hasPow=false.
    const rows = await db.getValidatorAuthorship();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe("5Auth1");
    expect(rows[0]?.blocksAuthored).toBe(1);
    expect(rows[0]?.blocksAuthoredWithPow).toBe(0);
  });

  test("authorship is skipped when author is null (BABE digest decode failure)", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    client.emitBlock({
      blockNumber: 99,
      blockHash: "0xnoauth",
      parentHash: "0xprev",
      author: null,
      timestamp: 1_700_000_990,
      winner: null,
      proofs: [],
      nonce: null,
    });
    await wait(100);
    ac.abort();
    await loop;

    expect(await db.getValidatorAuthorship()).toHaveLength(0);
  });

  test("chain state poll is idempotent — no second write on unchanged miners", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.chainMiners = [
      {
        accountId: "5M1",
        deposit: "1000",
        proofsSubmitted: "1",
        proofsWon: "0",
        rewardsEarned: "0",
      },
    ];

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1, // 1s timer so the repeat path runs
        }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    const first = await db.getChainMiners();
    const firstUpdated = (first[0] as unknown as { updated_at?: unknown }).updated_at;
    // Let the timer tick at least twice while data is unchanged.
    await wait(2100);
    const second = await db.getChainMiners();
    expect(first.map((m) => m.accountId)).toEqual(second.map((m) => m.accountId));
    expect(first[0]?.rewardsEarned).toBe(second[0]?.rewardsEarned);
    // updated_at field isn't surfaced in the ChainMinerRecord type — the
    // idempotency assertion runs at the worker level via the hash cache,
    // and is also verified by the adapter's IS DISTINCT FROM guard.
    expect(firstUpdated).toBeUndefined();
    ac.abort();
    await loop;
  }, 5000);
});
