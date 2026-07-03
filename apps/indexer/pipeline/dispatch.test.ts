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

  return {
    processFinalizedBlock: async (n: string) => events(Number(n)),
    getQBlock: async (n: string) =>
      WINNERS.includes(Number(n))
        ? {
            miner: "5GWinner",
            energyMilli: -14_000_000 - Number(n),
            reward: "1000",
            submittedAt: n,
            nonce: String(1000 + Number(n)),
            difficulty: { maxEnergyMilli: -13_900_000, minDiversityMilli: 100, minSolutions: 1 },
          }
        : null,
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
  opts: { once?: boolean } = {},
): Promise<Rig> {
  const client = makeFakeClient();
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
      // authorship.startBlock() = 0 and the fake chain synthesizes events
      // for every height, so the dense walk reaches genesis: blocks 0..HEAD.
      const [author] = await db.getValidatorAuthorship();
      expect(author?.blocksAuthored).toBe(HEAD + 1);
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
        expect(author?.blocksAuthored).toBe(HEAD + 1); // no double counts
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
