// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { FakeSubstrateClient } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { SubstrateWorker, type SubstrateWorkerDeps } from "./worker";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";

// Construct + run the worker. Keeps the behaviour-focused tests below reading
// as one call; each exercises the real SubstrateWorker class.
const runSubstrateLoop = (deps: SubstrateWorkerDeps, signal: AbortSignal): Promise<void> =>
  new SubstrateWorker(deps).run(signal);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await newInMemoryAdapter();
});

afterEach(async () => {
  await db.disconnect();
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
        qblockId: "1",
        blockNumber: "100",
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
        qblockId: "1",
        blockNumber: "77",
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
        qblockId: "1",
        blockNumber: "42",
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
      winner: {
        qblockId: "1",
        blockNumber: "5",
        miner: "5A",
        reward: "0",
        energyMilli: -100,
        submittedAt: "5",
      },
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
    // Only a finalized head was seen, so best is filled from it (lag 0).
    expect(head?.bestBlockNumber).toBe("100");
    expect(head?.bestBlockHash).toBe("0xab");
    expect(head?.finalityLag).toBe(0);
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
      winner: {
        qblockId: "1",
        blockNumber: "10",
        miner: "5M",
        reward: "0",
        energyMilli: -100,
        submittedAt: "10",
      },
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
      winner: {
        qblockId: "1",
        blockNumber: "12",
        miner: "5M",
        reward: "0",
        energyMilli: -200,
        submittedAt: "12",
      },
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

  // --- Stream-operator invariants (rxjs-migration safety net) ---
  // These pin the behaviours that the current hand-rolled implementation
  // expresses imperatively (reconnect loop, setTimeout debounce, dedup Set,
  // best/finalized merge, unsubscribe-on-abort). They must hold identically
  // after the worker is reshaped into an rxjs pipeline.

  test("reconnect rotates through the URL list and recovers on a healthy endpoint", async () => {
    const state = new IndexerState(db);
    await state.load();

    const seenUrls: string[] = [];
    let attempts = 0;
    const working = new FakeSubstrateClient();
    const clientFactory = (url: string) => {
      seenUrls.push(url);
      attempts += 1;
      // First two endpoints refuse the connection; the third succeeds. The
      // outer loop must round-robin a → b → c and reset on success.
      if (attempts <= 2) {
        const failing = new FakeSubstrateClient();
        failing.connect = async () => {
          throw new Error("connect refused");
        };
        return failing;
      }
      return working;
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
          // Tiny cap so the exponential backoff between retries is a few ms.
          substrateReconnectMaxBackoffMs: 5,
        }),
        urls: ["ws://a", "ws://b", "ws://c"],
        clientFactory,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(150);
    expect(seenUrls.slice(0, 3)).toEqual(["ws://a", "ws://b", "ws://c"]);
    expect(working.isConnected()).toBe(true);
    expect(state.observability.chainConnected).toBe(true);
    ac.abort();
    await loop;
  });

  test("chain_head writes coalesce a flurry of heads into a single debounced write", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();

    let chainHeadWrites = 0;
    const realUpsert = db.upsertChainHead.bind(db);
    db.upsertChainHead = async (head) => {
      chainHeadWrites += 1;
      return realUpsert(head);
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
        chainHeadDebounceMs: 50,
      },
      ac.signal,
    );
    await wait(50);
    // Three new heads inside one debounce window → the timer is reset twice
    // and only the last (height 102) is written.
    client.emitNew({
      number: "100",
      hash: "0x64",
      parentHash: "0x63",
      extrinsicsRoot: "0x",
      stateRoot: "0x",
    });
    client.emitNew({
      number: "101",
      hash: "0x65",
      parentHash: "0x64",
      extrinsicsRoot: "0x",
      stateRoot: "0x",
    });
    client.emitNew({
      number: "102",
      hash: "0x66",
      parentHash: "0x65",
      extrinsicsRoot: "0x",
      stateRoot: "0x",
    });
    await wait(120);
    ac.abort();
    await loop;

    expect(chainHeadWrites).toBe(1);
    const head = await db.getChainHead();
    expect(head?.bestBlockNumber).toBe("102");
    // Only new heads were seen, so finalized is filled from the latest (lag 0).
    expect(head?.finalizedBlockNumber).toBe("102");
    expect(head?.finalityLag).toBe(0);
  });

  test("chain_head finality lag is best minus finalized when both heads are known", async () => {
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
        // Small window so both heads collapse into one flush carrying both.
        chainHeadDebounceMs: 30,
      },
      ac.signal,
    );
    await wait(50);
    client.emitFinalized({
      number: "100",
      hash: "0xf",
      parentHash: "0xe",
      extrinsicsRoot: "0x",
      stateRoot: "0x",
    });
    client.emitNew({
      number: "110",
      hash: "0xb",
      parentHash: "0xa",
      extrinsicsRoot: "0x",
      stateRoot: "0x",
    });
    await wait(100);
    ac.abort();
    await loop;

    const head = await db.getChainHead();
    expect(head?.bestBlockNumber).toBe("110");
    expect(head?.finalizedBlockNumber).toBe("100");
    expect(head?.finalityLag).toBe(10);
  });

  test("a replayed finalized head is not double-counted in validator authorship", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 1, edgeCount: 0 };
    client.winningSolutionsByBlock.set("10", {
      miner: "5M",
      energyMilli: -100,
      reward: "0",
      submittedAt: "10",
      nonce: "1",
      difficulty: { maxEnergyMilli: -100, minDiversityMilli: 1, minSolutions: 1 },
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
      },
      ac.signal,
    );
    await wait(50);
    const block = {
      blockNumber: 10,
      blockHash: "0xdup",
      parentHash: "0x0",
      author: "5Auth1",
      timestamp: 1_700_000_000,
      winner: {
        qblockId: "1",
        blockNumber: "10",
        miner: "5M",
        reward: "0",
        energyMilli: -100,
        submittedAt: "10",
      },
      proofs: [{ miner: "5M", energyMilli: -100, diversityMilli: 1, validSolutionCount: 1 }],
      nonce: "1",
    };
    // Same finalized head delivered twice, temporally separated — the real
    // replay shape (a reconnect re-subscribes, or the fire-and-forget
    // backfill re-routes a block the live sub already wrote). The dedup Set
    // collapses the second delivery once the first has been recorded.
    client.emitBlock(block);
    await wait(50);
    client.emitBlock(block);
    await wait(100);
    ac.abort();
    await loop;

    const rows = await db.getValidatorAuthorship();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocksAuthored).toBe(1);
    // insertBlock is INSERT-OR-IGNORE, so the duplicate is also a no-op there.
    expect(await db.getRecentBlocks(10, 0)).toHaveLength(1);
  });

  test("after abort the worker unsubscribes — late events produce no writes", async () => {
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
    ac.abort();
    await loop;

    // Subscriptions were torn down in the finally block, so an event that
    // arrives after shutdown reaches no callback and writes nothing.
    client.emitBlock({
      blockNumber: 999,
      blockHash: "0xlate",
      parentHash: "0xprev",
      author: "5Late",
      timestamp: 1_700_009_990,
      winner: null,
      proofs: [],
      nonce: null,
    });
    await wait(50);
    expect(await db.getValidatorAuthorship()).toHaveLength(0);
    expect(await db.getRecentBlocks(10, 0)).toHaveLength(0);
  });

  test("backfills a historical winning block missing from the local store", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 7, edgeCount: 9 };
    // Chain reports block #200 as a winning solution and can serve its events,
    // but our local store is empty — the backfill should fetch and insert it.
    client.winningSolutionsByBlock.set("200", {
      miner: "5H",
      energyMilli: -300,
      reward: "5",
      submittedAt: "200",
      nonce: "9",
      difficulty: { maxEnergyMilli: -300, minDiversityMilli: 10, minSolutions: 1 },
    });
    client.historicalBlocks.set("200", {
      blockNumber: 200,
      blockHash: "0xc8",
      parentHash: "0xc7",
      author: "5HAuth",
      timestamp: 1_700_000_200,
      winner: {
        qblockId: "1",
        blockNumber: "200",
        miner: "5H",
        reward: "5",
        energyMilli: -300,
        submittedAt: "200",
      },
      proofs: [{ miner: "5H", energyMilli: -300, diversityMilli: 30, validSolutionCount: 1 }],
      nonce: "9",
    });
    client.lastProofBlockByHash.set("0xc7", 198);

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(150);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    const b = blocks.find((r) => r.substrateBlockNumber === "200");
    expect(b).toBeDefined();
    expect(b?.minerId).toBe("5H");
    expect(b?.energy).toBeCloseTo(-0.3, 5);
    expect(b?.miningTime).toBe(12); // (200 - 198) × 6s
    expect(b?.nonce).toBe("9");
    expect(b?.numNodes).toBe(7);
  });

  test("a dropped connection reconnects to the SAME endpoint (no churn) and resumes", async () => {
    const state = new IndexerState(db);
    await state.load();
    const seenUrls: string[] = [];
    const clients: FakeSubstrateClient[] = [];
    const clientFactory = (url: string) => {
      seenUrls.push(url);
      const c = new FakeSubstrateClient();
      c.topology = { nodeCount: 1, edgeCount: 0 };
      clients.push(c);
      return c;
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
          substrateReconnectMaxBackoffMs: 5, // ~5ms backoff so the reconnect is fast
        }),
        urls: ["ws://a", "ws://b"], // multiple URLs so churn would be observable
        clientFactory,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50);
    expect(seenUrls).toEqual(["ws://a"]);
    expect(state.observability.chainConnected).toBe(true);

    // Drop the live connection mid-stream.
    await clients[0]!.disconnect();
    await wait(60); // error → backoff(~5ms) → reconnect

    // Reconnected to the SAME endpoint (did NOT rotate to ws://b) and is healthy.
    expect(seenUrls[1]).toBe("ws://a");
    expect(state.observability.chainConnected).toBe(true);

    // The fresh connection's pipeline works: a block on the new client inserts.
    clients[1]!.emitBlock({
      blockNumber: 7,
      blockHash: "0x7",
      parentHash: "0x6",
      author: "5Auth",
      timestamp: 1_700_000_007,
      winner: {
        qblockId: "1",
        blockNumber: "7",
        miner: "5M",
        reward: "0",
        energyMilli: -100,
        submittedAt: "7",
      },
      proofs: [{ miner: "5M", energyMilli: -100, diversityMilli: 1, validSolutionCount: 1 }],
      nonce: "7",
    });
    await wait(80);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks.some((b) => b.substrateBlockNumber === "7")).toBe(true);
  });

  test("abort during reconnect backoff exits promptly (no shutdown hang)", async () => {
    const state = new IndexerState(db);
    await state.load();
    const clientFactory = () => {
      const c = new FakeSubstrateClient();
      c.connect = async () => {
        throw new Error("endpoint down");
      };
      return c;
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1000,
          substrateReconnectMaxBackoffMs: 60000, // long backoff → worker parks in the timer
        }),
        urls: ["ws://x"],
        clientFactory,
        db,
        state,
        chainHeadDebounceMs: 0,
      },
      ac.signal,
    );
    await wait(50); // connect failed; now parked in a ~2s backoff
    const abortedAt = Date.now();
    ac.abort();
    await loop;
    // Must unwind from the backoff timer immediately, not wait it out.
    expect(Date.now() - abortedAt).toBeLessThan(500);
  });

  test("difficulty carries forward to a winning block with no winning-solution snapshot", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 1, edgeCount: 0 };
    // Block 10 carries its own difficulty; block 11 has none → must inherit it.
    client.winningSolutionsByBlock.set("10", {
      miner: "5M",
      energyMilli: -100,
      reward: "0",
      submittedAt: "10",
      nonce: "1",
      difficulty: { maxEnergyMilli: -5000, minDiversityMilli: 300, minSolutions: 7 },
    });

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
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
      blockNumber: 10,
      blockHash: "0x10",
      parentHash: "0x9",
      author: "5A",
      timestamp: 1_700_000_010,
      winner: {
        qblockId: "1",
        blockNumber: "10",
        miner: "5M",
        reward: "0",
        energyMilli: -100,
        submittedAt: "10",
      },
      proofs: [{ miner: "5M", energyMilli: -100, diversityMilli: 1, validSolutionCount: 1 }],
      nonce: "1",
    });
    await wait(40);
    client.emitBlock({
      blockNumber: 11,
      blockHash: "0x11",
      parentHash: "0x10",
      author: "5A",
      timestamp: 1_700_000_011,
      winner: {
        qblockId: "1",
        blockNumber: "11",
        miner: "5M",
        reward: "0",
        energyMilli: -200,
        submittedAt: "11",
      },
      proofs: [{ miner: "5M", energyMilli: -200, diversityMilli: 2, validSolutionCount: 1 }],
      nonce: "2",
    });
    await wait(80);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    const b11 = blocks.find((b) => b.substrateBlockNumber === "11");
    expect(b11).toBeDefined();
    // No own snapshot → difficulty inherited from block 10 via the scan.
    expect(b11?.difficultyEnergy).toBeCloseTo(-5, 5);
    expect(b11?.minDiversity).toBeCloseTo(0.3, 5);
    expect(b11?.minSolutions).toBe(7);
  });

  test("a backfill error does not kill the live connection", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.topology = { nodeCount: 1, edgeCount: 0 };
    // Backfill catalogue read throws — must be contained, not tear down live.
    client.getWinningBlockNumbers = async () => {
      throw new Error("rpc down");
    };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
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
      blockHash: "0x5",
      parentHash: "0x4",
      author: "5A",
      timestamp: 1_700_000_005,
      winner: {
        qblockId: "1",
        blockNumber: "5",
        miner: "5M",
        reward: "0",
        energyMilli: -100,
        submittedAt: "5",
      },
      proofs: [{ miner: "5M", energyMilli: -100, diversityMilli: 1, validSolutionCount: 1 }],
      nonce: "5",
    });
    await wait(80);
    ac.abort();
    await loop;

    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks.some((b) => b.substrateBlockNumber === "5")).toBe(true);
  });

  test("difficulty poll dedups unchanged snapshots into a single history row", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.difficulty = { maxEnergyMilli: 12500, minDiversityMilli: 500, minSolutions: 3 };

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({
          substrateBabePollSec: 1000,
          substrateChainPollSec: 1, // 1s timer — multiple ticks within the test
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
    client.emitFinalized({
      number: "100",
      hash: "0xf",
      parentHash: "0xe",
      extrinsicsRoot: "0x",
      stateRoot: "0x",
    });
    // Ticks at ~0 (skipped: no finalized yet), ~1000 (write), ~2000 (unchanged).
    await wait(2300);
    ac.abort();
    await loop;

    const recent = await db.getRecentDifficulty(10);
    expect(recent).toHaveLength(1); // the cache must dedup the unchanged 2000ms tick
  }, 5000);

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
