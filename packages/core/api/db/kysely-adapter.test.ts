// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { KyselyAdapter } from "./kysely-adapter";
import { createPgliteHarness, type PgliteHarness } from "./pglite-support";
import type {
  BlockRecord,
  ChainHead,
  IndexerObservability,
  MinerHardwareRecord,
  MiningSubmissionRecord,
  NodeDescriptorRecord,
} from "@quip/shared/telemetry";

const sampleBlock = (overrides: Partial<BlockRecord> = {}): BlockRecord => ({
  blockHash: "0xpow1",
  substrateBlockNumber: "100",
  substrateBlockHash: "0xsub1",
  substrateParentHash: "0xsub0",
  timestamp: 1700000000,
  minerId: "5GPP",
  energy: -1.5,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 1.25,
  reward: "1000000000000",
  qblockId: "1",
  nonce: "1",
  numNodes: 2,
  numEdges: 3,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: false,
  topologyHash: null,
  ...overrides,
});

const sampleHead = (overrides: Partial<ChainHead> = {}): ChainHead => ({
  bestBlockNumber: "200",
  bestBlockHash: "0xbest",
  finalizedBlockNumber: "190",
  finalizedBlockHash: "0xfinal",
  finalityLag: 10,
  qblockCount: 5,
  currentQBlockId: "6",
  currentQBlockParticipants: 3,
  runtime: {
    specName: "quip",
    specVersion: 21,
    transactionVersion: 1,
    implName: "quip-node",
    lastRuntimeUpgrade: "180",
  },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const sampleHardware = (overrides: Partial<MinerHardwareRecord> = {}): MinerHardwareRecord => ({
  accountId: "5Acc",
  nodeId: "node-1",
  miners: [{ id: "m1", type: "GPU" }],
  primaryType: "GPU",
  source: "self",
  observedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const sampleDescriptor = (overrides: Partial<NodeDescriptorRecord> = {}): NodeDescriptorRecord => ({
  accountId: "5Acc",
  blockNumber: "120",
  blockHash: "0xnode",
  extrinsicIndex: 2,
  blockTimestamp: 1700000000,
  firstBlockTimestamp: 1700000000,
  descriptor: { nodeName: "node-1" } as NodeDescriptorRecord["descriptor"],
  observedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const sampleSubmission = (
  overrides: Partial<MiningSubmissionRecord> = {},
): MiningSubmissionRecord => ({
  minerId: "5GPP",
  solutionNumber: 42,
  tsNs: "1700000000000000000",
  energyMilli: 1500,
  diversityMilli: 2500,
  thresholdMilli: 1000,
  lastProofBlockHash: "0xlastproof",
  extrinsicHash: null,
  chainBlockHash: null,
  chainBlockNumber: null,
  powSequence: 49,
  outcome: "submitted",
  attemptCount: 7,
  bestEnergyMilli: 1400,
  numValid: 3,
  minerType: "CUDA",
  qpuAccessTimeUs: 0,
  observedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function runSuite(label: string, make: () => Promise<PgliteHarness>): void {
  describe(`KyselyAdapter (${label})`, () => {
    let harness: PgliteHarness;
    let db: KyselyAdapter;

    beforeAll(async () => {
      harness = await make();
      db = harness.adapter;
    });
    afterAll(async () => {
      await harness.close();
    });
    beforeEach(async () => {
      await harness.reset();
    });

    describe("blocks", () => {
      it("inserts and reads back every field", async () => {
        await db.insertBlock(sampleBlock({ finalized: true }));
        const [b] = await db.getRecentBlocks(10);
        expect(b).toEqual(sampleBlock({ finalized: true }));
      });

      it("ignores duplicate block_hash", async () => {
        await db.insertBlock(sampleBlock());
        await db.insertBlock(sampleBlock({ minerId: "5OTHER" }));
        const blocks = await db.getRecentBlocks(10);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.minerId).toBe("5GPP");
      });

      it("paginates newest-first by numeric block number", async () => {
        for (const n of [2, 10, 1]) {
          await db.insertBlock(
            sampleBlock({ blockHash: `0x${n}`, substrateBlockNumber: String(n) }),
          );
        }
        const page = await db.getRecentBlocks(2, 0);
        expect(page.map((b) => b.substrateBlockNumber)).toEqual(["10", "2"]);
        const next = await db.getRecentBlocks(2, 2);
        expect(next.map((b) => b.substrateBlockNumber)).toEqual(["1"]);
      });

      it("filters by miner and finalizes monotonically", async () => {
        await db.insertBlock(sampleBlock({ blockHash: "0xa", minerId: "5A" }));
        await db.insertBlock(sampleBlock({ blockHash: "0xb", minerId: "5B" }));
        expect(await db.getBlocksByMiner("5A", 10)).toHaveLength(1);
        await db.markBlockFinalized("0xa");
        const [a] = await db.getBlocksByMiner("5A", 10);
        expect(a?.finalized).toBe(true);
      });

      it("getExistingBlockNumbers returns only the present subset", async () => {
        for (const n of ["10", "20", "30"]) {
          await db.insertBlock(sampleBlock({ blockHash: `0x${n}`, substrateBlockNumber: n }));
        }
        const present = await db.getExistingBlockNumbers(["5", "10", "25", "30", "99"]);
        expect([...present].sort()).toEqual(["10", "30"]);
      });

      it("getExistingBlockNumbers is an empty-input no-op", async () => {
        await db.insertBlock(sampleBlock());
        expect(await db.getExistingBlockNumbers([])).toEqual([]);
      });

      it("getMinerWins aggregates per miner: count, best energy, avg time, last win", async () => {
        // Miner 5A: two wins; 5B: one win. Aggregates must reflect exactly
        // what the rows say — the leaderboard sorts and displays these as-is.
        await db.insertBlock(
          sampleBlock({
            blockHash: "0xa1",
            substrateBlockNumber: "1",
            minerId: "5A",
            energy: -1.0,
            miningTime: 10,
            timestamp: 1700000000,
          }),
        );
        await db.insertBlock(
          sampleBlock({
            blockHash: "0xa2",
            substrateBlockNumber: "3",
            minerId: "5A",
            energy: -2.5,
            miningTime: 20,
            timestamp: 1700000200,
          }),
        );
        await db.insertBlock(
          sampleBlock({
            blockHash: "0xb1",
            substrateBlockNumber: "2",
            minerId: "5B",
            energy: -0.5,
            miningTime: 7,
            timestamp: 1700000100,
          }),
        );
        const rows = await db.getMinerWins();
        expect(rows).toEqual([
          { minerId: "5A", wins: 2, bestEnergy: -2.5, avgMiningTime: 15, lastWonAt: 1700000200 },
          { minerId: "5B", wins: 1, bestEnergy: -0.5, avgMiningTime: 7, lastWonAt: 1700000100 },
        ]);
      });

      it("getMinerWins returns [] on an empty blocks table", async () => {
        expect(await db.getMinerWins()).toEqual([]);
      });

      it("getExistingBlockNumbers handles a lookup larger than the bind-parameter ceiling", async () => {
        // Seed a handful of real blocks, then ask about 70k numbers (> the
        // 65535 single-statement ceiling) — the adapter must chunk the IN-list.
        for (const n of ["3", "5", "70001"]) {
          await db.insertBlock(sampleBlock({ blockHash: `0x${n}`, substrateBlockNumber: n }));
        }
        const query = Array.from({ length: 70_000 }, (_, i) => String(i));
        const present = await db.getExistingBlockNumbers(query);
        expect([...present].sort()).toEqual(["3", "5"]); // 70001 is outside [0,70000)
      });
    });

    describe("meta", () => {
      it("roundtrips self address and observability", async () => {
        expect(await db.getSelfAddress()).toBeNull();
        await db.setSelfAddress("5Self");
        expect(await db.getSelfAddress()).toBe("5Self");

        expect(await db.getIndexerObservability()).toBeNull();
        const obs = {
          chainHeadFromNode: null,
          lastStatusFetchAt: "2026-01-01T00:00:00.000Z",
          lastBlockInsertAt: null,
          lastSubstrateEventAt: null,
          bestBlockHeight: "200",
          finalizedBlockHeight: "190",
          chainConnected: true,
        } as IndexerObservability;
        await db.setIndexerObservability(obs);
        expect(await db.getIndexerObservability()).toMatchObject({
          lastStatusFetchAt: "2026-01-01T00:00:00.000Z",
          chainConnected: true,
          bestBlockHeight: "200",
        });
      });
    });

    describe("chain head", () => {
      it("upserts idempotently and roundtrips timestamps + counts", async () => {
        await db.upsertChainHead(sampleHead());
        await db.upsertChainHead(sampleHead());
        expect(await db.getChainHead()).toEqual(sampleHead());
      });
    });

    describe("babe", () => {
      it("rolls over the current epoch", async () => {
        await db.upsertBabeEpoch({
          epochIndex: 7,
          currentSlot: "1000",
          epochStartSlot: "900",
          slotsPerEpoch: 100,
          currentSlotInEpoch: 50,
          authorityCount: 3,
        });
        await db.upsertBabeEpoch({
          epochIndex: 8,
          currentSlot: "1100",
          epochStartSlot: "1000",
          slotsPerEpoch: 100,
          currentSlotInEpoch: 10,
          authorityCount: 3,
        });
        expect((await db.getCurrentBabeEpoch())?.epochIndex).toBe(8);
      });

      it("flips is_active for authorities that drop out", async () => {
        await db.upsertBabeEpoch({
          epochIndex: 7,
          currentSlot: "1000",
          epochStartSlot: "900",
          slotsPerEpoch: 100,
          currentSlotInEpoch: 50,
          authorityCount: 2,
        });
        await db.upsertBabeAuthorities(7, [
          { accountId: "5A", displayName: null },
          { accountId: "5B", displayName: "Bee" },
        ]);
        await db.upsertBabeAuthorities(7, [{ accountId: "5A", displayName: null }]);
        const active = await db.getActiveBabeAuthorities();
        expect(active.map((a) => a.accountId)).toEqual(["5A"]);
      });

      it("demotes every authority when the incoming set is empty", async () => {
        await db.upsertBabeEpoch({
          epochIndex: 7,
          currentSlot: "1000",
          epochStartSlot: "900",
          slotsPerEpoch: 100,
          currentSlotInEpoch: 50,
          authorityCount: 2,
        });
        await db.upsertBabeAuthorities(7, [
          { accountId: "5A", displayName: null },
          { accountId: "5B", displayName: "Bee" },
        ]);
        await db.upsertBabeAuthorities(7, []);
        expect(await db.getActiveBabeAuthorities()).toEqual([]);
      });
    });

    describe("chain miners", () => {
      it("orders by rewards desc and upserts", async () => {
        await db.upsertChainMiners([
          {
            accountId: "5A",
            deposit: "1",
            proofsSubmitted: "1",
            proofsWon: "0",
            rewardsEarned: "100",
          },
          {
            accountId: "5B",
            deposit: "1",
            proofsSubmitted: "1",
            proofsWon: "0",
            rewardsEarned: "900",
          },
        ]);
        const miners = await db.getChainMiners();
        expect(miners.map((m) => m.accountId)).toEqual(["5B", "5A"]);
      });

      it("batch-upserts a mix of updates and inserts in one call", async () => {
        await db.upsertChainMiners([
          {
            accountId: "5A",
            deposit: "1",
            proofsSubmitted: "1",
            proofsWon: "0",
            rewardsEarned: "100",
          },
          {
            accountId: "5B",
            deposit: "1",
            proofsSubmitted: "2",
            proofsWon: "1",
            rewardsEarned: "900",
          },
        ]);
        // Bump 5A past 5B, leave 5B unchanged, add 5C — all in one batch.
        await db.upsertChainMiners([
          {
            accountId: "5A",
            deposit: "1",
            proofsSubmitted: "5",
            proofsWon: "2",
            rewardsEarned: "950",
          },
          {
            accountId: "5B",
            deposit: "1",
            proofsSubmitted: "2",
            proofsWon: "1",
            rewardsEarned: "900",
          },
          {
            accountId: "5C",
            deposit: "1",
            proofsSubmitted: "0",
            proofsWon: "0",
            rewardsEarned: "500",
          },
        ]);
        const miners = await db.getChainMiners();
        expect(miners.map((m) => [m.accountId, m.proofsSubmitted, m.rewardsEarned])).toEqual([
          ["5A", "5", "950"],
          ["5B", "2", "900"],
          ["5C", "0", "500"],
        ]);
      });

      it("treats an empty batch as a no-op", async () => {
        await db.upsertChainMiners([
          {
            accountId: "5A",
            deposit: "1",
            proofsSubmitted: "1",
            proofsWon: "0",
            rewardsEarned: "100",
          },
        ]);
        await db.upsertChainMiners([]);
        const miners = await db.getChainMiners();
        expect(miners.map((m) => m.accountId)).toEqual(["5A"]);
      });

      it("upserts a batch larger than the bind-parameter ceiling", async () => {
        // 12k miners × 6 columns = 72k params > Postgres' 65535 ceiling, so a
        // single statement would fail; the adapter must chunk.
        const miners = Array.from({ length: 12_000 }, (_, i) => ({
          accountId: `5acc${i}`,
          deposit: "1",
          proofsSubmitted: "1",
          proofsWon: "0",
          rewardsEarned: String(i),
        }));
        await db.upsertChainMiners(miners);
        expect(await db.getChainMiners()).toHaveLength(12_000);
      });
    });

    describe("difficulty", () => {
      it("is append-only and newest-first", async () => {
        await db.insertDifficultySnapshot({
          observedAtBlock: "100",
          difficultyEnergy: -1,
          minDiversity: 0,
          minSolutions: 1,
          observedAt: "2026-01-01T00:00:00.000Z",
          topologyHash: null,
          source: "poll",
        });
        await db.insertDifficultySnapshot({
          observedAtBlock: "100",
          difficultyEnergy: -999,
          minDiversity: 0,
          minSolutions: 1,
          observedAt: "2026-01-02T00:00:00.000Z",
          topologyHash: null,
          source: "poll",
        });
        const rows = await db.getRecentDifficulty(10);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.difficultyEnergy).toBe(-1);
      });

      it("getDifficultySince returns rows at/after the cutoff, oldest-first", async () => {
        const snap = (block: string, energy: number, observedAt: string) => ({
          observedAtBlock: block,
          difficultyEnergy: energy,
          minDiversity: 0,
          minSolutions: 1,
          observedAt,
          topologyHash: null,
          source: "poll" as const,
        });
        await db.insertDifficultySnapshot(snap("10", -10, "2026-01-01T00:00:00.000Z"));
        await db.insertDifficultySnapshot(snap("20", -20, "2026-01-02T00:00:00.000Z"));
        await db.insertDifficultySnapshot(snap("30", -30, "2026-01-03T00:00:00.000Z"));

        const since = await db.getDifficultySince("2026-01-02T00:00:00.000Z");
        // Cutoff is inclusive; results ascend by observed_at so the chart draws
        // left-to-right without a client-side reverse.
        expect(since.map((r) => r.difficultyEnergy)).toEqual([-20, -30]);
      });
    });

    describe("miner hardware", () => {
      it("roundtrips with JSON miners", async () => {
        await db.upsertMinerHardware(sampleHardware());
        expect(await db.getMinerHardware("5Acc")).toEqual(sampleHardware());
        expect(await db.getMinerHardware("nope")).toBeNull();
        expect(await db.getAllMinerHardware()).toHaveLength(1);
      });
    });

    describe("validator authorship (row-per-block, spec §9)", () => {
      // Seed the legacy counter table directly — the write path no longer
      // touches it, but the union read floors by it until cutover.
      const seedLegacy = (accountId: string, authored: number, pow: number, lastBlock: string) =>
        harness.db
          .insertInto("validator_authorship")
          .values({
            account_id: accountId,
            blocks_authored: String(authored),
            blocks_authored_with_pow: String(pow),
            last_authored_block: lastBlock,
            last_authored_at: "2026-01-01T00:00:00.000Z",
          })
          .execute();

      it("counts blocks and PoW wins via the new table", async () => {
        await db.recordValidatorAuthorship("5A", "10", 1700000000, false);
        await db.recordValidatorAuthorship("5A", "11", 1700000060, true);
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(2);
        expect(a?.blocksAuthoredWithPow).toBe(1);
        expect(a?.lastAuthoredBlock).toBe("11");
        expect(a?.lastAuthoredAt).toBe(new Date(1700000060 * 1000).toISOString());
      });

      it("replaying the same (validator, block) never double-counts", async () => {
        await db.recordValidatorAuthorship("5A", "10", 1700000000, true);
        await db.recordValidatorAuthorship("5A", "10", 1700000000, true);
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(1);
        expect(a?.blocksAuthoredWithPow).toBe(1);
      });

      it("union read floors by frozen legacy counters until the walk overtakes", async () => {
        await seedLegacy("5A", 5, 2, "9");
        await db.recordValidatorAuthorship("5A", "11", 1700000060, true);
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(5); // GREATEST(legacy 5, new 1)
        expect(a?.blocksAuthoredWithPow).toBe(2); // GREATEST(legacy 2, new 1)
        expect(a?.lastAuthoredBlock).toBe("11"); // last-authored from the newer side
        expect(a?.lastAuthoredAt).toBe(new Date(1700000060 * 1000).toISOString());
      });

      it("legacy-only validators stay visible in the union", async () => {
        await seedLegacy("5B", 3, 0, "7");
        await db.recordValidatorAuthorship("5A", "11", 1700000060, false);
        const rows = await db.getValidatorAuthorship();
        expect(rows.map((r) => r.accountId).sort()).toEqual(["5A", "5B"]);
        const b = rows.find((r) => r.accountId === "5B");
        expect(b?.blocksAuthored).toBe(3);
        expect(b?.lastAuthoredBlock).toBe("7");
      });

      it("tryAuthorshipCutover refuses while any validator's new count trails the legacy count", async () => {
        await seedLegacy("5A", 5, 2, "9");
        await db.recordValidatorAuthorship("5A", "11", 1700000060, true); // 1 < 5
        expect(await db.tryAuthorshipCutover()).toBe(false);
        // still union-served: legacy floor holds
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(5);
      });

      it("tryAuthorshipCutover flips once counts catch up and recomputes the summary", async () => {
        await seedLegacy("5A", 2, 1, "9");
        await db.recordValidatorAuthorship("5A", "10", 1700000000, true);
        await db.recordValidatorAuthorship("5A", "11", 1700000060, false);
        expect(await db.tryAuthorshipCutover()).toBe(true);
        // summary cache now equals the new-table aggregate
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(2);
        expect(a?.blocksAuthoredWithPow).toBe(1);
        expect(a?.lastAuthoredBlock).toBe("11");
        // idempotent: second call stays true
        expect(await db.tryAuthorshipCutover()).toBe(true);
      });

      it("recomputeAuthorshipSummary refreshes the cache after new rows land", async () => {
        await db.recordValidatorAuthorship("5A", "10", 1700000000, false);
        expect(await db.tryAuthorshipCutover()).toBe(true);
        await db.recordValidatorAuthorship("5A", "11", 1700000060, true);
        await db.recomputeAuthorshipSummary();
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(2);
        expect(a?.blocksAuthoredWithPow).toBe(1);
        expect(a?.lastAuthoredBlock).toBe("11");
      });
    });

    describe("difficulty source & precedence (spec §9.3)", () => {
      const snap = (
        block: string,
        energy: number,
        source: "block" | "poll",
        observedAt = "2026-01-02T00:00:00.000Z",
      ) => ({
        observedAtBlock: block,
        difficultyEnergy: energy,
        minDiversity: 0,
        minSolutions: 1,
        observedAt,
        topologyHash: null,
        source,
      });

      it("block write converts an occupying poll row (block-wins) and stays idempotent", async () => {
        await db.insertDifficultySnapshot(snap("100", -10, "poll"));
        await db.insertDifficultySnapshot(snap("100", -20, "block", "2026-01-03T00:00:00.000Z"));
        let rows = await db.getRecentDifficulty(10);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.difficultyEnergy).toBe(-20);
        expect(rows[0]?.source).toBe("block");
        // replay is a no-op (WHERE source='poll' guard fails)
        await db.insertDifficultySnapshot(snap("100", -30, "block"));
        rows = await db.getRecentDifficulty(10);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.difficultyEnergy).toBe(-20);
      });

      it("poll write never overwrites a block row", async () => {
        await db.insertDifficultySnapshot(snap("100", -20, "block"));
        await db.insertDifficultySnapshot(snap("100", -10, "poll"));
        const rows = await db.getRecentDifficulty(10);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.difficultyEnergy).toBe(-20);
        expect(rows[0]?.source).toBe("block");
      });

      it("deleteDifficultyHistoryBySource('block') leaves poll rows intact", async () => {
        await db.insertDifficultySnapshot(snap("100", -10, "poll", "2026-01-02T00:00:00.000Z"));
        await db.insertDifficultySnapshot(snap("200", -20, "block", "2026-01-03T00:00:00.000Z"));
        const deleted = await db.deleteDifficultyHistoryBySource("block");
        expect(deleted).toBe(1);
        const rows = await db.getRecentDifficulty(10);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.observedAtBlock).toBe("100");
        expect(rows[0]?.source).toBe("poll");
      });

      it("getDifficultyAnchorBefore returns the newest row strictly before the cutoff", async () => {
        await db.insertDifficultySnapshot(snap("10", -10, "poll", "2026-01-01T00:00:00.000Z"));
        await db.insertDifficultySnapshot(snap("20", -20, "poll", "2026-01-02T00:00:00.000Z"));
        await db.insertDifficultySnapshot(snap("30", -30, "poll", "2026-01-03T00:00:00.000Z"));
        const anchor = await db.getDifficultyAnchorBefore("2026-01-03T00:00:00.000Z");
        expect(anchor?.observedAtBlock).toBe("20"); // strictly before — row AT the cutoff is in-window
        expect(await db.getDifficultyAnchorBefore("2026-01-01T00:00:00.000Z")).toBeNull();
      });
    });

    describe("coverage generation guard (spec §7)", () => {
      it("writes only when the stamped generation matches", async () => {
        // default generation is 1 when never bumped
        expect(await db.getIndexerGeneration("difficulty")).toBe(1);
        expect(await db.setCoverageIfGeneration("difficulty", 1, `{"v":1}`)).toBe(true);
        expect(await db.getCoverage("difficulty")).toBe(`{"v":1}`);

        expect(await db.bumpIndexerGeneration("difficulty")).toBe(2);
        // stale in-flight flush from generation 1 is dropped
        expect(await db.setCoverageIfGeneration("difficulty", 1, `{"v":1,"stale":true}`)).toBe(
          false,
        );
        expect(await db.getCoverage("difficulty")).toBe(`{"v":1}`);
        // current-generation flush lands
        expect(await db.setCoverageIfGeneration("difficulty", 2, `{"v":1,"gen":2}`)).toBe(true);
        expect(await db.getCoverage("difficulty")).toBe(`{"v":1,"gen":2}`);
      });

      it("clearCoverage removes the coverage row for a fresh re-walk", async () => {
        await db.setCoverageIfGeneration("winners", 1, `{"v":1}`);
        await db.clearCoverage("winners");
        expect(await db.getCoverage("winners")).toBeNull();
      });
    });

    describe("node descriptors", () => {
      it("upserts by newest (block, extrinsic), preserving first timestamp", async () => {
        await db.upsertNodeDescriptor(sampleDescriptor());
        await db.upsertNodeDescriptor(
          sampleDescriptor({
            blockNumber: "130",
            blockTimestamp: 1700000999,
            descriptor: { nodeName: "node-renamed" } as NodeDescriptorRecord["descriptor"],
          }),
        );
        const d = await db.getNodeDescriptor("5Acc");
        expect(d?.blockNumber).toBe("130");
        expect(d?.firstBlockTimestamp).toBe(1700000000);
        expect((d?.descriptor as { nodeName: string }).nodeName).toBe("node-renamed");

        await db.upsertNodeDescriptor(sampleDescriptor({ blockNumber: "120" }));
        expect((await db.getNodeDescriptor("5Acc"))?.blockNumber).toBe("130");

        expect(await db.getAllNodeDescriptors()).toHaveLength(1);
      });

      it("backfillNodeDescriptorFirstSeen lowers firstSeen but never raises it", async () => {
        await db.upsertNodeDescriptor(sampleDescriptor({ firstBlockTimestamp: 1700000000 }));

        // Earlier value wins.
        await db.backfillNodeDescriptorFirstSeen("5Acc", 1699990000);
        expect((await db.getNodeDescriptor("5Acc"))?.firstBlockTimestamp).toBe(1699990000);

        // A later value is ignored (LEAST guard).
        await db.backfillNodeDescriptorFirstSeen("5Acc", 1700500000);
        expect((await db.getNodeDescriptor("5Acc"))?.firstBlockTimestamp).toBe(1699990000);

        // No row for the account → no-op (no throw, nothing created).
        await db.backfillNodeDescriptorFirstSeen("5Missing", 1);
        expect(await db.getNodeDescriptor("5Missing")).toBeNull();
      });
    });

    describe("checkpoints", () => {
      it("descriptor checkpoint advances monotonically", async () => {
        expect(await db.getDescriptorCheckpoint()).toBeNull();
        await db.setDescriptorCheckpoint("100");
        await db.setDescriptorCheckpoint("50");
        expect(await db.getDescriptorCheckpoint()).toBe("100");
        await db.setDescriptorCheckpoint("200");
        expect(await db.getDescriptorCheckpoint()).toBe("200");
      });

      it("mining checkpoint advances monotonically", async () => {
        expect(await db.getMiningCheckpoint("5GPP")).toBeNull();
        await db.setMiningCheckpoint("5GPP", 100);
        await db.setMiningCheckpoint("5GPP", 50);
        expect(await db.getMiningCheckpoint("5GPP")).toBe(100);
      });
    });

    describe("mining submissions", () => {
      it("upserts, reads newest-first, counts, and resets", async () => {
        await db.insertMiningSubmission(sampleSubmission({ solutionNumber: 41 }));
        await db.insertMiningSubmission(sampleSubmission({ solutionNumber: 42 }));
        // re-fetch flips chain_block_number from null → populated
        await db.insertMiningSubmission(
          sampleSubmission({ solutionNumber: 42, chainBlockNumber: "100", outcome: "won" }),
        );

        const recent = await db.getRecentMiningSubmissions("5GPP", 10);
        expect(recent.map((s) => s.solutionNumber)).toEqual([42, 41]);
        expect(recent[0]?.chainBlockNumber).toBe("100");
        expect(recent[0]?.outcome).toBe("won");
        expect(recent[1]).toEqual(sampleSubmission({ solutionNumber: 41 }));

        expect(await db.countMiningSubmissionsWithAttempts("5GPP")).toBe(2);

        await db.setMiningCheckpoint("5GPP", 42);
        await db.resetMiningHistory("5GPP");
        expect(await db.getRecentMiningSubmissions("5GPP", 10)).toHaveLength(0);
        expect(await db.getMiningCheckpoint("5GPP")).toBeNull();
      });
    });
  });
}

runSuite("pglite", createPgliteHarness);
