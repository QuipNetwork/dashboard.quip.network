// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R5 archive-pruning degradation (spec §8, step-6 gate): the three decided
// cases through the real dispatcher + coverage store, plus the boot re-probe
// that self-deepens history after archive rotation.

import { beforeEach, describe, expect, it } from "bun:test";
import { Subject, firstValueFrom, timer } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { BlockEvents } from "../clients/substrate-client";
import { StatePrunedError } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { newInMemoryAdapter } from "../core/test-helpers";
import type { ChainClient } from "../substrate/ports";
import { isComplete, parseCoverage } from "./coverage";
import { CoverageStore, DispatcherStream } from "./dispatch";
import { authorshipPlugin } from "./plugins/authorship";
import { winnersPlugin } from "./plugins/winners";
import type { BlockIndexable } from "./plugin";
import { BackfillWalker, Reconciler } from "./producers";
import { QueueCore } from "./queue";

const HEAD = 110;

interface FakeKnobs {
  pruneEventsBelow?: number; // processFinalizedBlock throws pruned below this
  pruneTopologyBelow?: number; // getDefaultTopologyAt throws pruned below this
  pruneLastProofFor?: Set<string>; // parent hashes whose state read is pruned
  winners?: number[];
}

function makeClient(knobs: FakeKnobs): ChainClient {
  const winners = knobs.winners ?? [];
  const events = (n: number): BlockEvents =>
    ({
      blockNumber: n,
      blockHash: `0xb${n}`,
      parentHash: `0xb${n - 1}`,
      author: "5GVal",
      timestamp: 1_700_000_000 + n * 6,
      winner: winners.includes(n)
        ? {
            miner: "5GW",
            energyMilli: -14_000_000,
            reward: "1",
            qblockId: "1",
            blockNumber: String(n),
          }
        : null,
      proofs: winners.includes(n)
        ? [{ miner: "5GW", energyMilli: -14_000_000, diversityMilli: 1, validSolutionCount: 1 }]
        : [],
      nonce: winners.includes(n) ? "42" : null,
    }) as BlockEvents;

  return {
    processFinalizedBlock: async (s: string) => {
      const n = Number(s);
      if (knobs.pruneEventsBelow !== undefined && n < knobs.pruneEventsBelow) {
        throw new StatePrunedError(`state already discarded for block ${n}`);
      }
      return events(n);
    },
    getQBlock: async (s: string) =>
      winners.includes(Number(s))
        ? {
            miner: "5GW",
            energyMilli: -14_000_000,
            reward: "1",
            submittedAt: s,
            nonce: "42",
            difficulty: { maxEnergyMilli: -13_000_000, minDiversityMilli: 0, minSolutions: 1 },
          }
        : null,
    // Winner-only items use the targeted decode. Events come from
    // `system.events.at` (block-data pruning still applies, mirroring
    // processFinalizedBlock); the winning solution carries topologyHash
    // inline, so the winner path never reads prunable historical topology.
    decodeWinnerBlock: async (s: string) => {
      const n = Number(s);
      if (knobs.pruneEventsBelow !== undefined && n < knobs.pruneEventsBelow) {
        throw new StatePrunedError(`state already discarded for block ${n}`);
      }
      if (!winners.includes(n)) return null;
      return {
        events: events(n),
        qblock: {
          miner: "5GW",
          energyMilli: -14_000_000,
          reward: "1",
          submittedAt: s,
          nonce: "42",
          difficulty: { maxEnergyMilli: -13_000_000, minDiversityMilli: 0, minSolutions: 1 },
          deviceAccessTimeUs: null,
          topologyHash: "0xSOL",
        },
      };
    },
    getLastProofBlockAt: async (hash: string) => {
      if (knobs.pruneLastProofFor?.has(hash)) {
        throw new StatePrunedError(`state already discarded at ${hash}`);
      }
      return 0;
    },
    getDefaultTopologyAt: async (s: string) => {
      if (knobs.pruneTopologyBelow !== undefined && Number(s) < knobs.pruneTopologyBelow) {
        throw new StatePrunedError(`state already discarded for block ${s}`);
      }
      return "0xHIST";
    },
    getTopology: async () => ({ nodeCount: 1, edgeCount: 1 }),
    getQBlockNumbers: async () => winners.map(String),
    getFinalizedHead: async () => String(HEAD),
  } as unknown as ChainClient;
}

interface Rig {
  queue: QueueCore;
  store: CoverageStore;
  dispatcher: DispatcherStream;
  reconciler: Reconciler;
  stop: () => void;
}

function makeRig(db: DatabaseAdapter, client: ChainClient, plugins: BlockIndexable[]): Rig {
  const state = new IndexerState(db);
  const now = () => Date.now();
  const wake$ = new Subject<void>();
  const queue = new QueueCore({
    backfillBlocksPerSec: 10_000,
    tipQuietMs: 0,
    lastEventAtMs: () => null,
  });
  const store = new CoverageStore(db, now);
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
    flushIntervalMs: 60_000,
  });
  const reconciler = new Reconciler({
    db,
    client,
    queue,
    walker,
    store,
    registry: plugins,
    now,
    rng: () => 0.5,
  });
  const sub = dispatcher.stream().subscribe({ error: () => {} });
  return { queue, store, dispatcher, reconciler, stop: () => sub.unsubscribe() };
}

async function settle(rig: Rig, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await firstValueFrom(timer(25));
    if (rig.queue.isDrained() || Date.now() > deadline) break;
  }
  await rig.store.flush();
}

// authorship variant whose walk starts at 100 so tests stay small.
function authorshipFrom100(): BlockIndexable {
  return { ...authorshipPlugin(), startBlock: async () => 100 };
}

let db: DatabaseAdapter;
beforeEach(async () => {
  db = await newInMemoryAdapter();
});

describe("case 3 — pruned block-data read ratchets the floor", () => {
  it("indexes what is visible, floors below, and coverage stays honest", async () => {
    const client = makeClient({ pruneEventsBelow: 105 });
    const rig = makeRig(db, client, [authorshipFrom100()]);
    try {
      await rig.reconciler.tick();
      await settle(rig);

      const [author] = await db.getValidatorAuthorship();
      expect(author?.blocksAuthored).toBe(HEAD - 105 + 1); // only 105..110

      const cov = parseCoverage(JSON.parse((await db.getCoverage("authorship")) ?? "null"));
      expect(cov?.prunedFloor).toBe(104);
      // Complete relative to the reachable depth — never lies about 100-104.
      expect(isComplete(cov!, HEAD)).toBe(true);
      expect(cov?.low).toBe(105);
    } finally {
      rig.stop();
    }
  });
});

describe("case 2 — pruned lastProof degrades miningTime; winner topology stays resilient", () => {
  it("keeps the solution's topologyHash under pruning, degrades miningTime, and covers the block", async () => {
    const client = makeClient({
      winners: [103],
      // Historical topology state is pruned at 103 — but the winner path reads
      // topologyHash from the winning solution, not from `getDefaultTopologyAt`,
      // so this no longer degrades the row (a strict improvement over the old
      // full-decode path, which floored topology to null here).
      pruneTopologyBelow: 104,
      pruneLastProofFor: new Set(["0xb102"]), // parent state pruned at the boundary
    });
    const plugins = [{ ...winnersPlugin(), startBlock: async () => 100 }];
    const rig = makeRig(db, client, plugins);
    try {
      await rig.reconciler.tick();
      await settle(rig);

      const [b] = await db.getRecentBlocks(10);
      expect(b?.substrateBlockNumber).toBe("103");
      expect(b?.topologyHash).toBe("0xSOL"); // resilient: from the solution, not prunable historical state
      expect(b?.miningTime).toBe(0); // case 2: lastProof pruned → mirrors lastProofBlock ≤ 0

      const cov = parseCoverage(JSON.parse((await db.getCoverage("winners")) ?? "null"));
      expect(isComplete(cov!, HEAD)).toBe(true); // block IS covered
      expect(cov?.prunedFloor).toBeNull(); // enrichment degradation ≠ data floor
      // The shallowest degraded block is still reported (via the lastProof read).
      expect(rig.dispatcher.topologyEnrichmentFloor()).toBe(103);
    } finally {
      rig.stop();
    }
  });
});

describe("case 4 — boot re-probe self-deepens after archive rotation", () => {
  it("clears the floor and backfills the previously pruned range", async () => {
    // First run against a pruned node.
    const rig1 = makeRig(db, makeClient({ pruneEventsBelow: 105 }), [authorshipFrom100()]);
    try {
      await rig1.reconciler.tick();
      await settle(rig1);
    } finally {
      rig1.stop();
    }

    // Reconnect against a true archive node (URL rotation landed elsewhere).
    const rig2 = makeRig(db, makeClient({}), [authorshipFrom100()]);
    try {
      await rig2.reconciler.tick(); // re-probe drops the floor + primes the walk
      await settle(rig2);
      const cov = parseCoverage(JSON.parse((await db.getCoverage("authorship")) ?? "null"));
      expect(cov?.prunedFloor).toBeNull();
      expect(cov?.low).toBe(100);
      expect(isComplete(cov!, HEAD)).toBe(true);
      const [author] = await db.getValidatorAuthorship();
      expect(author?.blocksAuthored).toBe(HEAD - 100 + 1); // full depth, no doubles
    } finally {
      rig2.stop();
    }
  });
});
