// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R4 reindex (spec §8, step-9 gate): generation bump → coverage clear →
// dropState, in that order; a crash between the steps leaves at worst extra
// uncovered rows that the idempotent re-walk overwrites. Plus the e2e:
// drop → re-walk → identical rows.

import { beforeEach, describe, expect, it } from "bun:test";
import { Subject, firstValueFrom, timer } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { BlockEvents } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { newInMemoryAdapter } from "../core/test-helpers";
import type { ChainClient } from "../substrate/ports";
import { CoverageStore, DispatcherStream } from "./dispatch";
import { authorshipPlugin } from "./plugins/authorship";
import { difficultyPlugin } from "./plugins/difficulty";
import { winnersPlugin } from "./plugins/winners";
import type { BlockIndexable } from "./plugin";
import { BackfillWalker, Reconciler } from "./producers";
import { QueueCore } from "./queue";
import { runReindex } from "./reindex";

const HEAD = 20;
const WINNERS = [5, 12];

function makeClient(): ChainClient {
  const events = (n: number): BlockEvents =>
    ({
      blockNumber: n,
      blockHash: `0xb${n}`,
      parentHash: `0xb${n - 1}`,
      author: "5GVal",
      timestamp: 1_700_000_000 + n * 6,
      winner: WINNERS.includes(n)
        ? { miner: "5GW", energyMilli: -14_000, reward: "1", qblockId: "1", blockNumber: String(n) }
        : null,
      proofs: WINNERS.includes(n)
        ? [{ miner: "5GW", energyMilli: -14_000, diversityMilli: 1, validSolutionCount: 1 }]
        : [],
      nonce: WINNERS.includes(n) ? "42" : null,
    }) as BlockEvents;
  return {
    processFinalizedBlock: async (s: string) => events(Number(s)),
    getQBlock: async (s: string) =>
      WINNERS.includes(Number(s))
        ? {
            miner: "5GW",
            energyMilli: -14_000,
            reward: "1",
            submittedAt: s,
            nonce: "42",
            difficulty: { maxEnergyMilli: -13_000, minDiversityMilli: 0, minSolutions: 1 },
          }
        : null,
    getLastProofBlockAt: async () => 0,
    getDefaultTopologyAt: async () => null,
    getTopology: async () => ({ nodeCount: 1, edgeCount: 1 }),
    getQBlockNumbers: async () => WINNERS.map(String),
    getFinalizedHead: async () => String(HEAD),
  } as unknown as ChainClient;
}

function plugins(): BlockIndexable[] {
  return [
    { ...winnersPlugin(), startBlock: async () => 0 },
    { ...difficultyPlugin(), startBlock: async () => 0 },
    // authorship's real startBlock now reads the chain head; pin to 0 here so
    // the reindex idempotence walk covers the full [0, HEAD] range like the
    // other plugins (this test exercises reindex mechanics, not the floor).
    { ...authorshipPlugin(), startBlock: async () => 0 },
  ];
}

async function walk(db: DatabaseAdapter): Promise<void> {
  const client = makeClient();
  const state = new IndexerState(db);
  const wake$ = new Subject<void>();
  const queue = new QueueCore({
    backfillBlocksPerSec: 10_000,
    tipQuietMs: 0,
    lastEventAtMs: () => null,
  });
  const store = new CoverageStore(db, () => Date.now());
  let dispatcher: DispatcherStream;
  const walker = new BackfillWalker({
    queue,
    wake: () => wake$.next(),
    onRangeComplete: (r) =>
      store.foldRange(r.plugin, r.range[0], r.range[1], dispatcher.errorBlocksFor(r.plugin)),
    chunkSize: 8,
    lowWater: 1000,
  });
  dispatcher = new DispatcherStream({
    db,
    state,
    now: () => Date.now(),
    client,
    queue,
    wake$,
    walker,
    store,
    blockPlugins: plugins(),
    flushIntervalMs: 60_000,
  });
  const reconciler = new Reconciler({
    db,
    client,
    queue,
    walker,
    store,
    registry: plugins(),
    now: () => Date.now(),
    rng: () => 0.5,
  });
  const sub = dispatcher.stream().subscribe({ error: () => {} });
  try {
    await reconciler.tick();
    const deadline = Date.now() + 3_000;
    while (!queue.isDrained() && Date.now() < deadline) await firstValueFrom(timer(25));
    await store.flush();
  } finally {
    sub.unsubscribe();
  }
}

async function snapshotRows(db: DatabaseAdapter): Promise<string> {
  const blocks = await db.getRecentBlocks(100);
  const difficulty = await db.getRecentDifficulty(100);
  const authorship = await db.getValidatorAuthorship();
  return JSON.stringify({ blocks, difficulty, authorship });
}

let db: DatabaseAdapter;
beforeEach(async () => {
  db = await newInMemoryAdapter();
});

describe("runReindex", () => {
  it("rejects unknown indexable names with the valid list", async () => {
    await expect(runReindex(db, plugins(), ["nope"])).rejects.toThrow(/nope.*winners/s);
  });

  it("bumps the generation, clears coverage, and drops only the target's rows", async () => {
    await walk(db);
    expect(await db.getRecentBlocks(100)).toHaveLength(2);
    // A poll row that reindex must never touch.
    await db.insertDifficultySnapshot({
      observedAtBlock: "999",
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      observedAt: "2026-07-01T00:00:00.000Z",
      topologyHash: null,
      source: "poll",
    });

    await runReindex(db, plugins(), ["difficulty"]);
    expect(await db.getIndexerGeneration("difficulty")).toBe(2);
    expect(await db.getCoverage("difficulty")).toBeNull();
    const rows = await db.getRecentDifficulty(100);
    expect(rows).toHaveLength(1); // block rows gone, poll row survives
    expect(rows[0]?.source).toBe("poll");
    // untouched siblings
    expect(await db.getIndexerGeneration("winners")).toBe(1);
    expect(await db.getRecentBlocks(100)).toHaveLength(2);
  });

  it("e2e: drop → re-walk → identical rows", async () => {
    await walk(db);
    const before = await snapshotRows(db);

    await runReindex(db, plugins(), []); // all indexables
    expect(await db.getRecentBlocks(100)).toHaveLength(0);
    expect(await db.getRecentDifficulty(100)).toHaveLength(0);

    await walk(db);
    expect(await snapshotRows(db)).toBe(before);
  });

  it("crash between coverage clear and dropState heals via the idempotent re-walk", async () => {
    await walk(db);
    const before = await snapshotRows(db);

    // Simulate the crash: steps (1)+(2) done, dropState never ran.
    await db.bumpIndexerGeneration("winners");
    await db.clearCoverage("winners");

    await walk(db); // rerun: re-walks from scratch over the surviving rows
    expect(await snapshotRows(db)).toBe(before); // no dupes, no losses
  });
});
