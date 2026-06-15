// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KyselyAdapter } from "./kysely-adapter";
import { Database } from "./sqlite-driver";
import type { BlockRecord } from "../../src/types/telemetry";

const sampleBlock = (overrides: Partial<BlockRecord> = {}): BlockRecord => ({
  blockHash: "0xpow1",
  substrateBlockNumber: "100",
  substrateBlockHash: "0xsub1",
  substrateParentHash: "0xsub0",
  timestamp: 1700000000,
  minerId: "5GPP",
  energy: -1,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 1,
  reward: "1000000000000",
  nonce: "1",
  numNodes: 1,
  numEdges: 1,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: false,
  ...overrides,
});

describe("KyselyAdapter.migrate (sqlite, forward-only)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quip-sqlite-test-"));
    dbPath = join(dir, "telemetry.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records the migration in the kysely_migration ledger on a fresh migrate", async () => {
    const db = new KyselyAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db.connect();
    await db.migrate();
    await db.disconnect();

    const raw = new Database(dbPath);
    const names = raw
      .query<{ name: string }, []>("SELECT name FROM kysely_migration ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["0001_initial"]);
    raw.close();
  });

  it("preserves data across a re-migrate (idempotent, never drops)", async () => {
    const db = new KyselyAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db.connect();
    await db.migrate();
    await db.insertBlock(sampleBlock());
    await db.migrate();
    const blocks = await db.getRecentBlocks(10);
    await db.disconnect();
    expect(blocks).toHaveLength(1);
  });

  it("adopts a pre-migration DB (tables + data, no ledger) without wiping it", async () => {
    // Seed the full schema + a row, then drop the ledger to emulate a DB that
    // predates proper migrations: the realistic prod state at cutover.
    const seed = new KyselyAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await seed.connect();
    await seed.migrate();
    await seed.insertBlock(sampleBlock());
    await seed.disconnect();

    const raw = new Database(dbPath);
    raw.run("DROP TABLE kysely_migration");
    raw.close();

    const db2 = new KyselyAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db2.connect();
    await db2.migrate();
    const blocks = await db2.getRecentBlocks(10);
    await db2.disconnect();
    expect(blocks).toHaveLength(1);
  });
});
