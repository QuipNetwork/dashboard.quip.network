// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION } from "./adapter";
import { SQLiteAdapter } from "./sqlite";
import type { BlockRecord } from "../../src/types/telemetry";

const sampleBlock = (): BlockRecord => ({
  epoch: "1000",
  blockIndex: 1,
  blockHash: "h",
  timestamp: 1,
  previousHash: "p",
  minerId: "m",
  minerCategory: "CPU",
  ecdsaPublicKey: "k",
  energy: -1,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 1,
  nonce: "1",
  numNodes: 1,
  numEdges: 1,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
});

describe("SQLiteAdapter.migrate schema-version check", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quip-sqlite-test-"));
    dbPath = join(dir, "telemetry.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes SCHEMA_VERSION to meta on a fresh migrate", async () => {
    const db = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db.connect();
    await db.migrate();
    await db.disconnect();

    const raw = new Database(dbPath);
    const row = raw
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    raw.close();
  });

  it("preserves data when migrate runs against a matching schema_version", async () => {
    const db = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db.connect();
    await db.migrate();
    await db.insertBlock(sampleBlock());
    await db.migrate();
    const blocks = await db.getAllBlocks();
    await db.disconnect();
    expect(blocks).toHaveLength(1);
  });

  it("drops and recreates all tables when schema_version is stale", async () => {
    const db = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db.connect();
    await db.migrate();
    await db.insertBlock(sampleBlock());
    await db.disconnect();

    // Simulate an old binary that wrote a previous schema version.
    const raw = new Database(dbPath);
    raw.run(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    raw.close();

    const db2 = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db2.connect();
    await db2.migrate();
    const blocks = await db2.getAllBlocks();
    await db2.disconnect();
    // Data was wiped because the stored version didn't match the code version.
    expect(blocks).toHaveLength(0);
  });

  it("treats a missing schema_version row as drift (first-run after upgrade)", async () => {
    // Emulate a pre-version-check database: tables exist but no meta row.
    const seed = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await seed.connect();
    await seed.migrate();
    await seed.insertBlock(sampleBlock());
    await seed.disconnect();

    const raw = new Database(dbPath);
    raw.run("DELETE FROM meta WHERE key = 'schema_version'");
    raw.close();

    const db2 = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: dbPath });
    await db2.connect();
    await db2.migrate();
    const blocks = await db2.getAllBlocks();
    await db2.disconnect();
    expect(blocks).toHaveLength(0);
  });
});
