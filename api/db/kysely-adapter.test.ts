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
  nonce: "1",
  numNodes: 2,
  numEdges: 3,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: false,
  ...overrides,
});

const sampleHead = (overrides: Partial<ChainHead> = {}): ChainHead => ({
  bestBlockNumber: "200",
  bestBlockHash: "0xbest",
  finalizedBlockNumber: "190",
  finalizedBlockHash: "0xfinal",
  finalityLag: 10,
  winningSolutionsCount: 5,
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
          await db.insertBlock(sampleBlock({ blockHash: `0x${n}`, substrateBlockNumber: String(n) }));
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
    });

    describe("chain miners", () => {
      it("orders by rewards desc and upserts", async () => {
        await db.upsertChainMiners([
          { accountId: "5A", deposit: "1", proofsSubmitted: "1", proofsWon: "0", rewardsEarned: "100" },
          { accountId: "5B", deposit: "1", proofsSubmitted: "1", proofsWon: "0", rewardsEarned: "900" },
        ]);
        const miners = await db.getChainMiners();
        expect(miners.map((m) => m.accountId)).toEqual(["5B", "5A"]);
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
        });
        await db.insertDifficultySnapshot({
          observedAtBlock: "100",
          difficultyEnergy: -999,
          minDiversity: 0,
          minSolutions: 1,
          observedAt: "2026-01-02T00:00:00.000Z",
        });
        const rows = await db.getRecentDifficulty(10);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.difficultyEnergy).toBe(-1);
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

    describe("validator authorship", () => {
      it("increments counters, PoW only when hasPow", async () => {
        await db.recordValidatorAuthorship("5A", "10", 1700000000, false);
        await db.recordValidatorAuthorship("5A", "11", 1700000060, true);
        const [a] = await db.getValidatorAuthorship();
        expect(a?.blocksAuthored).toBe(2);
        expect(a?.blocksAuthoredWithPow).toBe(1);
        expect(a?.lastAuthoredBlock).toBe("11");
        expect(a?.lastAuthoredAt).toBe(new Date(1700000060 * 1000).toISOString());
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
