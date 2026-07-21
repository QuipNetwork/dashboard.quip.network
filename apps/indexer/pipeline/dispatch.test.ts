// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2 integration (spec §15.5 gate): real plugins + real queue/walker/store
// against a fake chain and pglite. Proves per-plugin error isolation,
// crash-replay idempotency, and winner-domain range-completion convergence
// end to end through the dispatcher.

import { beforeEach, describe, expect, it } from "bun:test";
import { Subject, firstValueFrom, timer } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { BlockEvents } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { newInMemoryAdapter } from "../core/test-helpers";
import type { ChainClient } from "../substrate/ports";
import { isComplete, parseCoverage } from "./coverage";
import { CoverageStore, DispatcherStream } from "./dispatch";
import { authorshipPlugin } from "./plugins/authorship";
import { difficultyPlugin } from "./plugins/difficulty";
import { winnersPlugin } from "./plugins/winners";
import type { BlockIndexable } from "./plugin";
import { BackfillWalker, Reconciler } from "./producers";
import { QueueCore } from "./queue";

// Fake chain: heads 100..110, winners at 103 and 108.
const HEAD = 110;
const WINNERS = [103, 108];

function makeFakeClient(): ChainClient {
  const events = (n: number): BlockEvents =>
    ({
      blockNumber: n,
      blockHash: `0xb${n}`,
      parentHash: `0xb${n - 1}`,
      author: "5GVal",
      timestamp: 1_700_000_000 + n * 6,
      winner: WINNERS.includes(n)
        ? {
            miner: "5GWinner",
            energyMilli: -14_000_000 - n,
            reward: "1000",
            qblockId: String(WINNERS.indexOf(n) + 1),
            blockNumber: String(n),
          }
        : null,
      proofs: WINNERS.includes(n)
        ? [
            {
              miner: "5GWinner",
              energyMilli: -14_000_000 - n,
              diversityMilli: 500,
              validSolutionCount: 2,
            },
          ]
        : [],
      nonce: WINNERS.includes(n) ? String(1000 + n) : null,
    }) as BlockEvents;

  const qblock = (n: number) =>
    WINNERS.includes(n)
      ? {
          miner: "5GWinner",
          energyMilli: -14_000_000 - n,
          reward: "1000",
          submittedAt: String(n),
          nonce: String(1000 + n),
          difficulty: { maxEnergyMilli: -13_900_000, minDiversityMilli: 100, minSolutions: 1 },
          deviceAccessTimeUs: null,
          // Same hash the historical getDefaultTopologyAt returns — one static
          // topology (verified). The winner path stamps this without the read.
          topologyHash: "0xHIST",
        }
      : null;

  return {
    processFinalizedBlock: async (n: string) => events(Number(n)),
    // Targeted winner decode: events (author nulled) + the single QBlock fetch.
    decodeWinnerBlock: async (n: string) => {
      const e = events(Number(n));
      if (e.winner === null) return null;
      return { events: { ...e, author: null }, qblock: qblock(Number(n)) };
    },
    getQBlock: async (n: string) => qblock(Number(n)),
    getLastProofBlockAt: async () => 0,
    getDefaultTopologyAt: async () => "0xHIST",
    getTopology: async () => ({ nodeCount: 4, edgeCount: 8 }),
    getQBlockNumbers: async () => WINNERS.map(String),
    getFinalizedHead: async () => String(HEAD),
  } as unknown as ChainClient;
}

interface Rig {
  db: DatabaseAdapter;
  state: IndexerState;
  queue: QueueCore;
  wake$: Subject<void>;
  walker: BackfillWalker;
  store: CoverageStore;
  dispatcher: DispatcherStream;
  reconciler: Reconciler;
  stop: () => void;
}

async function makeRig(
  db: DatabaseAdapter,
  plugins: BlockIndexable[],
  opts: { once?: boolean; client?: ChainClient } = {},
): Promise<Rig> {
  const client = opts.client ?? makeFakeClient();
  const state = new IndexerState(db);
  const now = () => Date.now();
  const wake$ = new Subject<void>();
  const queue = new QueueCore({
    backfillBlocksPerSec: 10_000,
    tipQuietMs: 0,
    lastEventAtMs: () => null,
  });
  const store = new CoverageStore(db, now);
  // Wiring mirrors the step-7 connection assembly: range records fold into
  // coverage minus the dispatcher's per-plugin error blocks.
  let dispatcher: DispatcherStream;
  const walker = new BackfillWalker({
    queue,
    wake: () => wake$.next(),
    onRangeComplete: (r) =>
      store.foldRange(r.plugin, r.range[0], r.range[1], dispatcher.errorBlocksFor(r.plugin)),
    chunkSize: 4,
    lowWater: 1000,
  });
  dispatcher = new DispatcherStream({
    db,
    state,
    now,
    client,
    queue,
    wake$,
    walker,
    store,
    blockPlugins: plugins,
    flushIntervalMs: 60_000, // flushes driven explicitly in tests
  });
  const reconciler = new Reconciler({
    db,
    client,
    queue,
    walker,
    store,
    registry: plugins,
    now,
    once: opts.once ?? false,
    rng: () => 0.5,
  });
  const sub = dispatcher.stream().subscribe({ error: () => {} });
  return {
    db,
    state,
    queue,
    wake$,
    walker,
    store,
    dispatcher,
    reconciler,
    stop: () => sub.unsubscribe(),
  };
}

async function settle(rig: Rig, ms = 300): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await firstValueFrom(timer(25));
    if (rig.queue.isDrained() || Date.now() > deadline) break;
  }
  await rig.store.flush();
}

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await newInMemoryAdapter();
});

describe("dispatcher end-to-end (boot reconcile → converged coverage)", () => {
  it("indexes the fake chain and converges every plugin's coverage to [start, head]", async () => {
    const rig = await makeRig(db, [winnersPlugin(), difficultyPlugin(), authorshipPlugin()]);
    try {
      await rig.reconciler.tick(); // boot backfill (leading tick)
      await settle(rig, 3_000);

      // Rows: 2 winner blocks, 2 difficulty rows, 11 authorship blocks.
      expect((await db.getRecentBlocks(50)).map((b) => b.substrateBlockNumber).sort()).toEqual([
        "103",
        "108",
      ]);
      expect((await db.getRecentDifficulty(50)).map((r) => r.observedAtBlock).sort()).toEqual([
        "103",
        "108",
      ]);
      // authorship.startBlock() now reads the chain head (getFinalizedHead =
      // HEAD), so the dense walk only covers block HEAD itself — one authored
      // block. (Historical winner blocks below head are winner-only items and
      // take the targeted decode, which records no authorship.)
      const [author] = await db.getValidatorAuthorship();
      expect(author?.blocksAuthored).toBe(1);
      // Coverage converged for every plugin, winner-domain included (D1).
      for (const name of ["winners", "difficulty", "authorship"]) {
        const cov = parseCoverage(JSON.parse((await db.getCoverage(name)) ?? "null"));
        expect(cov).not.toBeNull();
        expect(isComplete(cov!, HEAD)).toBe(true);
      }
    } finally {
      rig.stop();
    }
  });

  it("crash-replay: a second identical walk leaves rows unchanged", async () => {
    const rig = await makeRig(db, [winnersPlugin(), difficultyPlugin(), authorshipPlugin()]);
    try {
      await rig.reconciler.tick();
      await settle(rig, 3_000);
      // Simulate the replay: wipe coverage (as if the flush never landed)
      // and re-walk everything.
      for (const name of ["winners", "difficulty", "authorship"]) await db.clearCoverage(name);
      const rig2 = await makeRig(db, [winnersPlugin(), difficultyPlugin(), authorshipPlugin()]);
      try {
        await rig2.reconciler.tick();
        await settle(rig2, 3_000);
        expect(await db.getRecentBlocks(50)).toHaveLength(2);
        expect(await db.getRecentDifficulty(50)).toHaveLength(2);
        const [author] = await db.getValidatorAuthorship();
        expect(author?.blocksAuthored).toBe(1); // head only; no double counts
      } finally {
        rig2.stop();
      }
    } finally {
      rig.stop();
    }
  });
});

describe("per-plugin error isolation", () => {
  it("a throwing plugin gaps only itself; siblings converge", async () => {
    const bomb: BlockIndexable = {
      name: "bomb",
      kind: "block",
      domain: "every-block",
      startBlock: async () => 100,
      onBlock: async (ctx) => {
        if (ctx.number === 105) throw new Error("boom");
      },
      dropState: async () => {},
    };
    const rig = await makeRig(db, [authorshipPlugin(), bomb]);
    try {
      await rig.reconciler.tick();
      await settle(rig, 3_000);

      const authorship = parseCoverage(JSON.parse((await db.getCoverage("authorship")) ?? "null"));
      expect(isComplete(authorship!, HEAD)).toBe(true); // sibling unharmed

      const bombCov = parseCoverage(JSON.parse((await db.getCoverage("bomb")) ?? "null"));
      expect(isComplete(bombCov!, HEAD)).toBe(false);
      expect(bombCov!.gaps).toEqual([[105, 105]]); // exactly the poisoned block
    } finally {
      rig.stop();
    }
  });
});

describe("--once exit condition", () => {
  it("done$ fires only when drained + covered + drift-free", async () => {
    const rig = await makeRig(db, [winnersPlugin(), difficultyPlugin(), authorshipPlugin()], {
      once: true,
    });
    try {
      let done = false;
      rig.reconciler.done$.subscribe(() => {
        done = true;
      });
      await rig.reconciler.tick(); // boot: work exists → not done
      expect(done).toBe(false);
      await settle(rig, 3_000);
      await rig.reconciler.tick(); // deciding tick: everything converged
      expect(done).toBe(true);
    } finally {
      rig.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3: winner-lane routing through the targeted decode + de-dupe.

interface SpyCounts {
  processFinalizedBlock: number;
  decodeWinnerBlock: number;
  getQBlock: number;
  getDefaultTopologyAt: number;
}

// Wraps makeFakeClient with call counters. `decodeWinnerBlock` mirrors
// production: it makes the SINGLE winning_solution fetch (the counted
// getQBlock) and returns it for the dispatcher to reuse — so a winner block
// that also read ctx.qblock() must still show exactly one getQBlock call.
function makeSpyClient(): { client: ChainClient; calls: SpyCounts } {
  const base = makeFakeClient();
  const calls: SpyCounts = {
    processFinalizedBlock: 0,
    decodeWinnerBlock: 0,
    getQBlock: 0,
    getDefaultTopologyAt: 0,
  };
  const getQBlock = async (n: string) => {
    calls.getQBlock++;
    return base.getQBlock(n);
  };
  const client = {
    ...base,
    getQBlock,
    processFinalizedBlock: async (n: string) => {
      calls.processFinalizedBlock++;
      return base.processFinalizedBlock(n);
    },
    getDefaultTopologyAt: async (n: string) => {
      calls.getDefaultTopologyAt++;
      return base.getDefaultTopologyAt(n);
    },
    decodeWinnerBlock: async (n: string) => {
      calls.decodeWinnerBlock++;
      const events = await base.processFinalizedBlock(n); // raw source, uncounted
      if (!events || events.winner === null) return null;
      const qblock = await getQBlock(n); // the ONE winning_solution call
      return { events: { ...events, author: null }, qblock };
    },
  } as unknown as ChainClient;
  return { client, calls };
}

// A no-op every-block plugin starting at genesis, so every block (winner
// blocks included) carries a non-winner-domain pending and takes the full path.
function everyBlockTag(): BlockIndexable {
  return {
    name: "tag",
    kind: "block",
    domain: "every-block",
    startBlock: async () => 0,
    onBlock: async () => {},
    dropState: async () => {},
  };
}

describe("winner-lane routing (targeted decode)", () => {
  it("routes winner-only backfill items through decodeWinnerBlock with exactly one winningSolution each", async () => {
    const { client, calls } = makeSpyClient();
    const rig = await makeRig(db, [winnersPlugin(), difficultyPlugin()], { client });
    try {
      await rig.reconciler.tick();
      await settle(rig, 3_000);

      // Both winner blocks decoded via the targeted path; full decode unused.
      expect(calls.decodeWinnerBlock).toBe(WINNERS.length);
      expect(calls.processFinalizedBlock).toBe(0);
      // Exactly one winning_solution (getQBlock) per winner block — the value
      // is threaded onto ctx, so difficulty's ctx.qblock() adds no extra call.
      expect(calls.getQBlock).toBe(WINNERS.length);
      // Rows still land.
      expect((await db.getRecentBlocks(50)).map((b) => b.substrateBlockNumber).sort()).toEqual([
        "103",
        "108",
      ]);
    } finally {
      rig.stop();
    }
  });

  it("winner-path row is byte-for-byte the full-decode row (golden equivalence)", async () => {
    // Full path: an every-block tag makes winner blocks non-winner-only, so
    // block 103 is decoded via processFinalizedBlock and stamped via the
    // historical getDefaultTopologyAt.
    const db2 = await newInMemoryAdapter();
    const rigFull = await makeRig(db2, [winnersPlugin(), difficultyPlugin(), everyBlockTag()]);
    try {
      await rigFull.reconciler.tick();
      await settle(rigFull, 3_000);
    } finally {
      rigFull.stop();
    }
    const fullRow = (await db2.getRecentBlocks(50)).find((b) => b.substrateBlockNumber === "103");

    // Winner path: same fixture, winner-only → decodeWinnerBlock + solution
    // topologyHash.
    const rigWin = await makeRig(db, [winnersPlugin(), difficultyPlugin()]);
    try {
      await rigWin.reconciler.tick();
      await settle(rigWin, 3_000);
    } finally {
      rigWin.stop();
    }
    const winRow = (await db.getRecentBlocks(50)).find((b) => b.substrateBlockNumber === "103");

    expect(winRow).toBeDefined();
    expect(winRow).toEqual(fullRow);
  });

  it("winner path stamps topology_hash from the solution, not a historical DefaultTopology read", async () => {
    const { client, calls } = makeSpyClient();
    const rig = await makeRig(db, [winnersPlugin(), difficultyPlugin()], { client });
    try {
      await rig.reconciler.tick();
      await settle(rig, 3_000);

      // The per-block historical read never happens on the winner path.
      expect(calls.getDefaultTopologyAt).toBe(0);
      // The stamped hash is the one the solution carried.
      const row = (await db.getRecentBlocks(50)).find((b) => b.substrateBlockNumber === "103");
      expect(row?.topologyHash).toBe("0xHIST");
    } finally {
      rig.stop();
    }
  });

  it("an item carrying an every-block plugin uses the full decode (processFinalizedBlock)", async () => {
    const { client, calls } = makeSpyClient();
    const rig = await makeRig(db, [winnersPlugin(), difficultyPlugin(), everyBlockTag()], {
      client,
    });
    try {
      await rig.reconciler.tick();
      await settle(rig, 3_000);

      // Every block (winner blocks included) carries `tag` → nothing is
      // winner-only → the targeted decode is never taken.
      expect(calls.decodeWinnerBlock).toBe(0);
      expect(calls.processFinalizedBlock).toBeGreaterThan(0);
    } finally {
      rig.stop();
    }
  });
});
