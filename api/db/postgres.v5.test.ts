// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { PostgresAdapter } from "./postgres";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
} from "../../src/types/telemetry";

const TEST_URL = process.env.TEST_POSTGRES_URL;

async function freshPostgres(): Promise<PostgresAdapter> {
  const db = new PostgresAdapter({ adapter: "postgres", databaseUrl: TEST_URL });
  await db.connect();
  await db.migrate();
  await db.setMetaRaw("schema_version", "-1");
  await db.migrate();
  return db;
}

const sampleHead = (): ChainHead => ({
  bestBlockNumber: "100",
  bestBlockHash: "0xabc",
  finalizedBlockNumber: "98",
  finalizedBlockHash: "0xdef",
  finalityLag: 2,
  runtime: {
    specName: "quip",
    specVersion: 101,
    transactionVersion: 2,
    implName: "quip",
    lastRuntimeUpgrade: null,
  },
  updatedAt: "2026-05-15T00:00:00.000Z",
});

const sampleEpoch = (idx: number): BabeEpochState => ({
  epochIndex: idx,
  currentSlot: String(idx * 2400),
  epochStartSlot: String(idx * 2400),
  slotsPerEpoch: 2400,
  currentSlotInEpoch: 0,
  authorityCount: 3,
});

const sampleAuthority = (accountId: string): BabeAuthorityRecord => ({
  accountId,
  displayName: null,
});

const sampleMiner = (
  accountId: string,
  rewardsEarned = "0",
): Omit<ChainMinerRecord, "telemetryNodeAddress"> => ({
  accountId,
  deposit: "1000000000000",
  proofsSubmitted: "42",
  proofsWon: "7",
  rewardsEarned,
});

const sampleBlock = (overrides: Partial<BlockRecord> = {}): BlockRecord => ({
  epoch: "1000",
  blockIndex: 1,
  blockHash: "h",
  timestamp: 1,
  previousHash: "p",
  minerId: "m",
  minerCategory: "CPU",
  ecdsaPublicKey: "k",
  energy: 12.5,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 1,
  nonce: "1",
  numNodes: 1,
  numEdges: 1,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  substrateBlockNumber: null,
  substrateBlockHash: null,
  substrateParentHash: null,
  extrinsicsRoot: null,
  stateRoot: null,
  finalized: false,
  isCanonical: true,
  ...overrides,
});

describe.skipIf(!TEST_URL)("PostgresAdapter v5 substrate state", () => {
  test("upsertChainHead is idempotent", async () => {
    const db = await freshPostgres();
    const head = sampleHead();
    await db.upsertChainHead(head);
    await db.upsertChainHead(head);
    const fetched = await db.getChainHead();
    expect(fetched).toEqual(head);
    await db.disconnect();
  });

  test("upsertBabeEpoch rolls over isCurrent", async () => {
    const db = await freshPostgres();
    await db.upsertBabeEpoch(sampleEpoch(7));
    await db.upsertBabeEpoch(sampleEpoch(8));
    const current = await db.getCurrentBabeEpoch();
    expect(current?.epochIndex).toBe(8);
    await db.disconnect();
  });

  test("upsertBabeAuthorities flips is_active for drops", async () => {
    const db = await freshPostgres();
    await db.upsertBabeEpoch(sampleEpoch(1));
    await db.upsertBabeAuthorities(1, [sampleAuthority("A"), sampleAuthority("B")]);
    await db.upsertBabeAuthorities(1, [sampleAuthority("A")]);
    const active = await db.getActiveBabeAuthorities();
    expect(active.map((a) => a.accountId)).toEqual(["A"]);
    await db.disconnect();
  });

  test("upsertChainMiners orders by rewards_earned DESC", async () => {
    const db = await freshPostgres();
    await db.upsertChainMiners([
      sampleMiner("M1", "100"),
      sampleMiner("M2", "300"),
      sampleMiner("M3", "200"),
    ]);
    const miners = await db.getChainMiners();
    expect(miners.map((m) => m.accountId)).toEqual(["M2", "M3", "M1"]);
    await db.disconnect();
  });

  test("insertDifficultySnapshot append-only", async () => {
    const db = await freshPostgres();
    await db.insertDifficultySnapshot({
      observedAtBlock: "100",
      difficultyEnergy: 12.5,
      minDiversity: 0.5,
      minSolutions: 3,
      minQuality: 0.25,
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    await db.insertDifficultySnapshot({
      observedAtBlock: "200",
      difficultyEnergy: 13.0,
      minDiversity: 0.5,
      minSolutions: 3,
      minQuality: 0.25,
      observedAt: "2026-05-15T00:10:00.000Z",
    });
    await db.insertDifficultySnapshot({
      observedAtBlock: "100",
      difficultyEnergy: 999,
      minDiversity: 0.5,
      minSolutions: 3,
      minQuality: 0.25,
      observedAt: "2026-05-15T00:20:00.000Z",
    });
    const recent = await db.getRecentDifficulty(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.observedAtBlock).toBe("200");
    expect(recent[1]?.difficultyEnergy).toBe(12.5);
    await db.disconnect();
  });

  test("findBlockByMinerAndEnergy returns most-recent match", async () => {
    const db = await freshPostgres();
    await db.insertBlock(sampleBlock({ blockIndex: 1, timestamp: 100, minerId: "M", energy: 12.5 }));
    await db.insertBlock(sampleBlock({ blockIndex: 2, timestamp: 200, minerId: "M", energy: 12.5 }));
    await db.insertBlock(sampleBlock({ blockIndex: 3, timestamp: 150, minerId: "N", energy: 12.5 }));
    const match = await db.findBlockByMinerAndEnergy("M", 12.5);
    expect(match).toEqual({ epoch: "1000", blockIndex: 2 });
    await db.disconnect();
  });

  test("updateBlockSubstrateFields enriches via COALESCE; monotonic finalized", async () => {
    const db = await freshPostgres();
    await db.insertBlock(sampleBlock());
    const r1 = await db.updateBlockSubstrateFields("1000", 1, {
      substrateBlockNumber: "42",
      substrateBlockHash: "0xsub",
    });
    expect(r1.matched).toBe(true);
    await db.updateBlockSubstrateFields("1000", 1, { finalized: true });
    const blocks = await db.getBlocksByEpoch("1000");
    expect(blocks[0]?.substrateBlockNumber).toBe("42");
    expect(blocks[0]?.substrateBlockHash).toBe("0xsub");
    expect(blocks[0]?.finalized).toBe(true);
    await db.disconnect();
  });

  test("markBlocksCanonical hides stale-fork blocks from default reads", async () => {
    const db = await freshPostgres();
    await db.insertBlock(sampleBlock({ epoch: "live", blockIndex: 1 }));
    await db.insertBlock(sampleBlock({ epoch: "dead", blockIndex: 1 }));
    await db.markBlocksCanonical(["dead"], false);
    const all = await db.getAllBlocks();
    expect(all.map((b) => b.epoch)).toEqual(["live"]);
    await db.disconnect();
  });

  test("updateEpochChainAnchor without touching status", async () => {
    const db = await freshPostgres();
    await db.insertBlock(sampleBlock({ epoch: "e1" }));
    await db.replaceEpochStatus([{ epoch: "e1", status: "live" }]);
    await db.updateEpochChainAnchor("e1", "0xanchor");
    const idx = await db.getIndex();
    expect(idx.epochs[0]?.status).toBe("live");
    await db.disconnect();
  });
});
