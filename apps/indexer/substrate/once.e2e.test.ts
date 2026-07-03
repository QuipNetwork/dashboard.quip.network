// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Step-11 gate (spec §14/§15.11): end-to-end `--once` through the REAL
// SubstrateWorker against FakeSubstrateClient + pglite. The seeded chain has
// winners, a pre-existing coverage gap, a pruned floor, non-winner stretches,
// and a pre-v0.2 winner (no qblock snapshot). The run must:
//   - index the winners with their qblock difficulty,
//   - write the ZERO_DIFFICULTY triple (and no difficulty_history row) for
//     the pre-v0.2 winner,
//   - heal the seeded coverage gap,
//   - keep the pruned floor honest,
//   - converge winner-domain coverage via range completion,
//   - publish §11 observability, and
//   - exit CLEANLY: the reconciler's done$ tears down the connection and
//     run() resolves without an abort.

import { beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { FakeSubstrateClient, type BlockEvents } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";
import { isComplete, parseCoverage, serializeCoverage, type Coverage } from "../pipeline/coverage";
import { SubstrateWorker } from "./worker";

const HEAD = 40;
const START = 5; // blocks 0-4 are pruned on this fake node
const WINNERS = [15, 30]; // post-v0.2: present in the qBlocks map
const PRE_V02_WINNER = 20; // a winner block absent from the map (no snapshot)
const GAP_BLOCK = 25; // pre-seeded coverage gap the run must heal

function makeEvents(n: number): BlockEvents {
  const isWinner = WINNERS.includes(n) || n === PRE_V02_WINNER;
  return {
    blockNumber: n,
    blockHash: `0xb${n}`,
    parentHash: `0xb${n - 1}`,
    author: "5GVal",
    timestamp: 1_700_000_000 + n * 6,
    winner: isWinner
      ? {
          qblockId: String(n),
          blockNumber: String(n),
          miner: "5GW",
          reward: "10",
          energyMilli: -14_000,
          submittedAt: String(n),
        }
      : null,
    proofs: isWinner
      ? [{ miner: "5GW", energyMilli: -14_000, diversityMilli: 100, validSolutionCount: 1 }]
      : [],
    nonce: isWinner ? String(1000 + n) : null,
  } as BlockEvents;
}

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await newInMemoryAdapter();
});

describe("end-to-end --once", () => {
  test(
    "drains, converges, publishes observability, and exits cleanly",
    async () => {
      const client = new FakeSubstrateClient();
      client.topology = { nodeCount: 8, edgeCount: 16 };
      client.finalizedHead = String(HEAD);
      client.pruneBelow(START);
      for (let n = START; n <= HEAD; n++) client.historicalBlocks.set(String(n), makeEvents(n));
      for (const w of WINNERS) {
        client.qblocksByBlock.set(String(w), {
          miner: "5GW",
          energyMilli: -14_000,
          reward: "10",
          submittedAt: String(w),
          nonce: String(1000 + w),
          difficulty: { maxEnergyMilli: -13_000, minDiversityMilli: 100, minSolutions: 2 },
        });
      }

      // A prior run's authorship state: rows for 5..40 EXCEPT the gap block,
      // coverage claiming exactly that (gap recorded, floor at 4).
      for (let n = START; n <= HEAD; n++) {
        if (n === GAP_BLOCK) continue;
        await db.recordValidatorAuthorship("5GVal", String(n), 1_700_000_000 + n * 6, false);
      }
      const priorAuthorship: Coverage = {
        v: 1,
        gen: 1,
        start: 0,
        low: START,
        high: HEAD,
        gaps: [[GAP_BLOCK, GAP_BLOCK]],
        prunedFloor: START - 1,
        updatedAt: null,
      };
      expect(
        await db.setCoverageIfGeneration(
          "authorship",
          1,
          serializeCoverage(priorAuthorship, "2026-07-01T00:00:00.000Z"),
        ),
      ).toBe(true);

      const state = new IndexerState(db);
      await state.load();
      const worker = new SubstrateWorker({
        config: makeConfig({ once: true, substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
      });

      // A live pre-v0.2 winner arrives at the tip mid-run: its runtime
      // winning_solution returns nothing, so the winners plugin must write
      // the ZERO_DIFFICULTY sentinel and difficulty must skip it.
      const emitLater = setTimeout(() => {
        client.emitFinalized({
          number: String(PRE_V02_WINNER),
          hash: `0xb${PRE_V02_WINNER}`,
          parentHash: `0xb${PRE_V02_WINNER - 1}`,
          extrinsicsRoot: "0x",
          stateRoot: "0x",
        });
      }, 600);

      // Clean exit is the assertion: no abort signal fires; done$ must end it.
      const ac = new AbortController();
      await worker.run(ac.signal);
      clearTimeout(emitLater);

      // --- rows ---
      const blocks = await db.getRecentBlocks(100);
      const byNum = new Map(blocks.map((b) => [b.substrateBlockNumber, b]));
      expect(byNum.get("15")?.difficultyEnergy).toBe(-13); // qblock difficulty
      expect(byNum.get("30")?.minSolutions).toBe(2);
      const preV02 = byNum.get(String(PRE_V02_WINNER));
      expect(preV02).toBeDefined();
      expect(preV02?.difficultyEnergy).toBe(0); // ZERO_DIFFICULTY sentinel
      expect(preV02?.minDiversity).toBe(0);
      expect(preV02?.minSolutions).toBe(0);

      const difficulty = await db.getRecentDifficulty(100);
      expect(difficulty.map((r) => r.observedAtBlock).sort()).toEqual(["15", "30"]);
      expect(difficulty.every((r) => r.source === "block")).toBe(true); // no pre-v0.2 row

      // The seeded gap healed; every block 5..40 is attributed exactly once.
      const [author] = await db.getValidatorAuthorship();
      expect(author?.blocksAuthored).toBe(HEAD - START + 1);

      // --- coverage ---
      for (const name of ["winners", "difficulty", "authorship"]) {
        const cov = parseCoverage(JSON.parse((await db.getCoverage(name)) ?? "null"));
        expect(cov).not.toBeNull();
        expect(isComplete(cov!, HEAD)).toBe(true);
        expect(cov!.gaps).toEqual([]);
      }
      // The pruned floor stayed honest (re-probe failed against this node).
      const authorship = parseCoverage(JSON.parse((await db.getCoverage("authorship")) ?? "null"));
      expect(authorship?.prunedFloor).toBe(START - 1);

      // --- observability (§11) ---
      const progress = state.observability.indexer;
      expect(progress).toBeDefined();
      expect(progress?.backfillQueueDepth).toBe(0);
      expect(progress?.coverage.authorship?.gapBlocks).toBe(0);
      expect(progress?.coverage.winners?.high).toBe(String(HEAD));
      expect(progress?.difficultyDataStartBlock).toBe("15"); // min qBlocks key
    },
    30_000,
  );
});
