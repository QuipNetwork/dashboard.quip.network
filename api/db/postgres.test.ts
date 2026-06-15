// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PostgresAdapter } from "./postgres";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  ChainHead,
  ChainMinerRecord,
} from "../../src/types/telemetry";

// Postgres integration tests require a reachable database. Gate behind
// TEST_POSTGRES_URL so CI and dev environments without a local postgres
// don't spuriously fail. The URL should point at a disposable database.
const TEST_URL = process.env.TEST_POSTGRES_URL;
const maybeDescribe = TEST_URL ? describe : describe.skip;

interface SqlClient {
  unsafe: (sql: string) => Promise<unknown[]>;
}

function rawSql(db: PostgresAdapter): SqlClient {
  return (db as unknown as { sql: SqlClient }).sql;
}

async function truncateAll(db: PostgresAdapter): Promise<void> {
  const sql = (db as unknown as { sql: SqlClient }).sql;
  await sql.unsafe(
    "TRUNCATE blocks, miner_hardware, meta, chain_head, babe_epochs, babe_authorities, chain_miners, difficulty_history",
  );
}

const sampleHead = (): ChainHead => ({
  bestBlockNumber: "100",
  bestBlockHash: "0xabc",
  finalizedBlockNumber: "98",
  finalizedBlockHash: "0xdef",
  finalityLag: 2,
  winningSolutionsCount: 42,
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
): Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware"> => ({
  accountId,
  deposit: "1000000000000",
  proofsSubmitted: "42",
  proofsWon: "7",
  rewardsEarned,
});

maybeDescribe("PostgresAdapter.migrate (forward-only)", () => {
  let db: PostgresAdapter;

  const sampleBlock = (blockHash: string) => ({
    blockHash,
    substrateBlockNumber: "1",
    substrateBlockHash: "0xs",
    substrateParentHash: "0xp",
    timestamp: 1,
    minerId: "M",
    energy: 0,
    diversity: 0,
    numValidSolutions: 0,
    miningTime: 0,
    reward: "0",
    nonce: "0",
    numNodes: 0,
    numEdges: 0,
    difficultyEnergy: 0,
    minDiversity: 0,
    minSolutions: 0,
    finalized: false,
  });

  beforeEach(async () => {
    db = new PostgresAdapter({ adapter: "postgres", databaseUrl: TEST_URL });
    await db.connect();
    await db.migrate();
    await truncateAll(db);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test("records the migration in the kysely_migration ledger", async () => {
    const rows = (await rawSql(db).unsafe(
      "SELECT name FROM kysely_migration ORDER BY name",
    )) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["0001_initial"]);
  });

  test("preserves data across a re-migrate (idempotent, never drops)", async () => {
    await db.insertBlock(sampleBlock("0xpow-keep"));
    expect((await db.getRecentBlocks(10)).length).toBe(1);
    await db.migrate();
    expect((await db.getRecentBlocks(10)).length).toBe(1);
  });

  test("adopts a pre-migration DB (tables + data, no ledger) without wiping it", async () => {
    await db.insertBlock(sampleBlock("0xpow-adopt"));
    // Emulate a DB that predates proper migrations: schema + data, no ledger.
    await rawSql(db).unsafe("DROP TABLE kysely_migration");
    await db.migrate();
    expect((await db.getRecentBlocks(10)).length).toBe(1);
  });
});

maybeDescribe("PostgresAdapter v5 substrate state (kept in v6)", () => {
  let db: PostgresAdapter;

  beforeEach(async () => {
    db = new PostgresAdapter({ adapter: "postgres", databaseUrl: TEST_URL });
    await db.connect();
    await db.migrate();
    await truncateAll(db);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test("upsertChainHead is idempotent", async () => {
    const head = sampleHead();
    await db.upsertChainHead(head);
    await db.upsertChainHead(head);
    const fetched = await db.getChainHead();
    expect(fetched).toEqual(head);
  });

  test("upsertBabeEpoch rolls over isCurrent", async () => {
    await db.upsertBabeEpoch(sampleEpoch(7));
    await db.upsertBabeEpoch(sampleEpoch(8));
    const current = await db.getCurrentBabeEpoch();
    expect(current?.epochIndex).toBe(8);
  });

  test("upsertBabeAuthorities flips is_active for drops", async () => {
    await db.upsertBabeEpoch(sampleEpoch(1));
    await db.upsertBabeAuthorities(1, [sampleAuthority("A"), sampleAuthority("B")]);
    await db.upsertBabeAuthorities(1, [sampleAuthority("A")]);
    const active = await db.getActiveBabeAuthorities();
    expect(active.map((a) => a.accountId)).toEqual(["A"]);
  });

  test("upsertChainMiners orders by rewards_earned DESC", async () => {
    await db.upsertChainMiners([
      sampleMiner("M1", "100"),
      sampleMiner("M2", "300"),
      sampleMiner("M3", "200"),
    ]);
    const miners = await db.getChainMiners();
    expect(miners.map((m) => m.accountId)).toEqual(["M2", "M3", "M1"]);
  });

  test("insertDifficultySnapshot append-only", async () => {
    await db.insertDifficultySnapshot({
      observedAtBlock: "100",
      difficultyEnergy: 12.5,
      minDiversity: 0.5,
      minSolutions: 3,
      observedAt: "2026-05-15T00:00:00.000Z",
    });
    await db.insertDifficultySnapshot({
      observedAtBlock: "200",
      difficultyEnergy: 13.0,
      minDiversity: 0.5,
      minSolutions: 3,
      observedAt: "2026-05-15T00:10:00.000Z",
    });
    // Duplicate observed_at_block — ON CONFLICT DO NOTHING swallows this.
    await db.insertDifficultySnapshot({
      observedAtBlock: "100",
      difficultyEnergy: 999,
      minDiversity: 0.5,
      minSolutions: 3,
      observedAt: "2026-05-15T00:20:00.000Z",
    });
    const recent = await db.getRecentDifficulty(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.observedAtBlock).toBe("200");
    expect(recent[1]?.difficultyEnergy).toBe(12.5);
  });
});
