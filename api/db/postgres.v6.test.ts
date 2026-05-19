// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PostgresAdapter } from "./postgres";
import type { BlockRecord, MinerHardwareRecord } from "../../src/types/telemetry";

// Postgres integration tests require a reachable database. Gate behind
// TEST_POSTGRES_URL so CI and dev environments without a local postgres
// don't spuriously fail. The URL should point at a disposable database —
// migrate() drops all owned tables on schema_version drift.
const TEST_URL = process.env.TEST_POSTGRES_URL;
const maybeDescribe = TEST_URL ? describe : describe.skip;

interface SqlClient {
  unsafe: (sql: string) => Promise<unknown>;
}

maybeDescribe("Postgres v6 schema", () => {
  let db: PostgresAdapter;

  beforeEach(async () => {
    db = new PostgresAdapter({ adapter: "postgres", databaseUrl: TEST_URL });
    await db.connect();
    await db.migrate();
    // Wipe to ensure isolation between tests (the test DB persists across
    // tests, unlike the temp-file SQLite fixture). Truncate every v6 table
    // including meta so setSelfAddress/observability start clean.
    const sql = (db as unknown as { sql: SqlClient }).sql;
    await sql.unsafe(
      "TRUNCATE blocks, miner_hardware, meta, chain_head, babe_epochs, babe_authorities, chain_miners, difficulty_history",
    );
  });

  afterEach(async () => {
    await db.disconnect();
  });

  const sample = (overrides: Partial<BlockRecord> = {}): BlockRecord => ({
    blockHash: "0xpow1",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xsub1",
    substrateParentHash: "0xsub0",
    timestamp: 1700000000,
    minerId: "5GPP",
    energy: -2510,
    diversity: 0.42,
    numValidSolutions: 5,
    qualityMilli: 850,
    miningTime: 6,
    reward: "1000000000000",
    nonce: "42",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -2500,
    minDiversity: 0.2,
    minSolutions: 5,
    finalized: false,
    ...overrides,
  });

  test("insertBlock + getRecentBlocks roundtrip with all fields", async () => {
    await db.insertBlock(sample());
    const recent = await db.getRecentBlocks(10, 0);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toEqual(sample());
  });

  test("getRecentBlocks paginates by substrate_block_number DESC", async () => {
    for (let i = 0; i < 5; i++) {
      await db.insertBlock(
        sample({ blockHash: `0xpow${i}`, substrateBlockNumber: String(100 + i) }),
      );
    }
    const page1 = await db.getRecentBlocks(2, 0);
    const page2 = await db.getRecentBlocks(2, 2);
    expect(page1.map((b) => b.substrateBlockNumber)).toEqual(["104", "103"]);
    expect(page2.map((b) => b.substrateBlockNumber)).toEqual(["102", "101"]);
  });

  test("getBlocksByMiner filters by SS58", async () => {
    await db.insertBlock(sample());
    await db.insertBlock(sample({ blockHash: "0xpow2", minerId: "5OTHER" }));
    const mine = await db.getBlocksByMiner("5GPP", 10);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.minerId).toBe("5GPP");
  });

  test("markBlockFinalized is monotonic and idempotent", async () => {
    await db.insertBlock(sample());
    await db.markBlockFinalized("0xpow1");
    expect((await db.getRecentBlocks(1, 0))[0]?.finalized).toBe(true);
    // Idempotent: calling again is a no-op
    await db.markBlockFinalized("0xpow1");
    expect((await db.getRecentBlocks(1, 0))[0]?.finalized).toBe(true);
  });

  test("insertBlock with duplicate block_hash is ignored", async () => {
    await db.insertBlock(sample());
    await db.insertBlock(sample({ minerId: "5OTHER" })); // duplicate PK, should not raise
    const recent = await db.getRecentBlocks(10, 0);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.minerId).toBe("5GPP"); // first write wins
  });

  test("upsertMinerHardware + getMinerHardware roundtrip", async () => {
    const rec: MinerHardwareRecord = {
      accountId: "5GPP",
      nodeId: "quip-miner-pow",
      miners: [{ id: "quip-miner-pow-CPU-1", type: "CPU" }],
      primaryType: "CPU",
      source: "self",
      observedAt: "2026-05-19T00:00:00.000Z",
    };
    await db.upsertMinerHardware(rec);
    expect(await db.getMinerHardware("5GPP")).toEqual(rec);
    // Upsert updates observed_at + miners
    const updated: MinerHardwareRecord = {
      ...rec,
      miners: [
        { id: "quip-miner-pow-CPU-1", type: "CPU" },
        { id: "quip-miner-pow-CPU-2", type: "CPU" },
      ],
      observedAt: "2026-05-19T00:10:00.000Z",
    };
    await db.upsertMinerHardware(updated);
    expect(await db.getMinerHardware("5GPP")).toEqual(updated);
  });

  test("getMinerHardware returns null for unknown accountId", async () => {
    expect(await db.getMinerHardware("nonexistent")).toBeNull();
  });

  test("getAllMinerHardware returns all rows, newest first", async () => {
    await db.upsertMinerHardware({
      accountId: "A",
      nodeId: "node-a",
      miners: [{ id: "m1", type: "CPU" }],
      primaryType: "CPU",
      source: "self",
      observedAt: "2026-05-19T00:00:00.000Z",
    });
    await db.upsertMinerHardware({
      accountId: "B",
      nodeId: "node-b",
      miners: [{ id: "m2", type: "GPU" }],
      primaryType: "GPU",
      source: "peer-query",
      observedAt: "2026-05-19T00:10:00.000Z",
    });
    const all = await db.getAllMinerHardware();
    expect(all).toHaveLength(2);
    expect(all[0]?.accountId).toBe("B"); // most recent first
  });

  test("setSelfAddress + getSelfAddress roundtrip via meta", async () => {
    expect(await db.getSelfAddress()).toBeNull();
    await db.setSelfAddress("5GPP");
    expect(await db.getSelfAddress()).toBe("5GPP");
    // Overwrite
    await db.setSelfAddress("5OTHER");
    expect(await db.getSelfAddress()).toBe("5OTHER");
  });

  test("legacy tables are dropped on migrate", async () => {
    // pg_catalog should not list any v5 legacy tables in the public schema.
    const sql = (db as unknown as {
      sql: (s: TemplateStringsArray) => Promise<Array<{ tablename: string }>>;
    }).sql;
    const rows = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const names = rows.map((r) => r.tablename);
    expect(names).not.toContain("epoch_status");
    expect(names).not.toContain("nodes_snapshot");
    expect(names).not.toContain("self_address");
    expect(names).not.toContain("indexer_cursors");
    expect(names).not.toContain("indexer_etags");
    // v6 tables ARE present
    expect(names).toContain("blocks");
    expect(names).toContain("miner_hardware");
    expect(names).toContain("chain_head");
  });
});
