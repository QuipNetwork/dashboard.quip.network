// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres, { type Sql } from "postgres";

const V5_SQL_PATH = join(import.meta.dir, "../api/db/migrations/v5-substrate-fields.sql");
const V6_SQL_PATH = join(import.meta.dir, "../api/db/migrations/v6-drop-epoch-abstraction.sql");

describe("v5 forward migration SQL", () => {
  const sql = readFileSync(V5_SQL_PATH, "utf8");

  test("uses idempotent guards for all column adds", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS substrate_block_number");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS substrate_block_hash");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS substrate_parent_hash");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS extrinsics_root");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS state_root");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS finalized");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS is_canonical");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS chain_anchor");
  });

  test("creates all new v5 tables", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chain_head");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS babe_epochs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS babe_authorities");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chain_miners");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS difficulty_history");
  });

  test("drops vestigial indexer_state", () => {
    expect(sql).toContain("DROP TABLE IF EXISTS indexer_state");
  });

  test("backfills is_canonical for stale_fork epochs", () => {
    expect(sql).toContain("UPDATE blocks SET is_canonical = FALSE");
    expect(sql).toContain("WHERE status = 'stale_fork'");
  });

  test("stamps schema_version=5 at the end", () => {
    expect(sql).toContain("schema_version");
    expect(sql).toMatch(/VALUES\s*\(\s*'schema_version'\s*,\s*'5'/);
  });

  test("wraps everything in a transaction", () => {
    expect(sql.trimStart()).toMatch(/^(--[^\n]*\n|\s)*BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;\s*$/);
  });
});

describe("v6 forward migration SQL", () => {
  const sql = readFileSync(V6_SQL_PATH, "utf8");

  test("idempotent table drops use IF EXISTS", () => {
    expect(sql).toContain("DROP TABLE IF EXISTS epoch_status");
    expect(sql).toContain("DROP TABLE IF EXISTS nodes_snapshot");
    expect(sql).toContain("DROP TABLE IF EXISTS self_address");
    expect(sql).toContain("DROP TABLE IF EXISTS indexer_cursors");
    expect(sql).toContain("DROP TABLE IF EXISTS indexer_etags");
  });

  test("miner_hardware is CREATE IF NOT EXISTS", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS miner_hardware");
  });

  test("legacy block columns dropped", () => {
    expect(sql).toContain("ALTER TABLE blocks DROP COLUMN IF EXISTS epoch");
    expect(sql).toContain("ALTER TABLE blocks DROP COLUMN IF EXISTS block_index");
    expect(sql).toContain("ALTER TABLE blocks DROP COLUMN IF EXISTS miner_category");
    expect(sql).toContain("ALTER TABLE blocks DROP COLUMN IF EXISTS ecdsa_public_key");
    expect(sql).toContain("ALTER TABLE blocks DROP COLUMN IF EXISTS is_canonical");
  });

  test("v6 block columns added with safe defaults", () => {
    expect(sql).toContain("ALTER TABLE blocks ADD COLUMN IF NOT EXISTS quality_milli");
    expect(sql).toContain("ALTER TABLE blocks ADD COLUMN IF NOT EXISTS reward");
    expect(sql).toContain("DEFAULT 0");
  });

  test("substrate_* columns set NOT NULL after backfill", () => {
    expect(sql).toContain(
      "UPDATE blocks SET substrate_block_number = 0 WHERE substrate_block_number IS NULL",
    );
    expect(sql).toContain("ALTER TABLE blocks ALTER COLUMN substrate_block_number SET NOT NULL");
    expect(sql).toContain("ALTER TABLE blocks ALTER COLUMN substrate_block_hash SET NOT NULL");
    expect(sql).toContain("ALTER TABLE blocks ALTER COLUMN substrate_parent_hash SET NOT NULL");
  });

  test("PK rebuilt on block_hash", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS blocks_pkey");
    expect(sql).toContain("ADD PRIMARY KEY (block_hash)");
  });

  test("schema_version updated to 6", () => {
    expect(sql).toContain("UPDATE meta SET value = '6'");
  });

  test("wrapped in transaction", () => {
    expect(sql.trim().startsWith("BEGIN")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });
});

// Live v5 → v6 smoke test. Stand up a Postgres, seed a v5-shaped DB with one
// real block row, run the v6 migration SQL, and verify the result. Skips
// unless TEST_POSTGRES_URL is set so CI / dev environments without a local
// postgres don't spuriously fail.
const TEST_URL = process.env.TEST_POSTGRES_URL;
const maybeDescribe = TEST_URL ? describe : describe.skip;

const V5_SEED_SQL = `
  CREATE TABLE blocks (
    epoch                  TEXT NOT NULL,
    block_index            INTEGER NOT NULL,
    block_hash             TEXT NOT NULL,
    timestamp              BIGINT NOT NULL,
    previous_hash          TEXT NOT NULL,
    miner_id               TEXT NOT NULL,
    miner_category         TEXT NOT NULL,
    ecdsa_public_key       TEXT NOT NULL,
    energy                 DOUBLE PRECISION NOT NULL,
    diversity              DOUBLE PRECISION NOT NULL,
    num_valid_solutions    INTEGER NOT NULL,
    mining_time            DOUBLE PRECISION NOT NULL,
    nonce                  NUMERIC NOT NULL,
    num_nodes              INTEGER NOT NULL,
    num_edges              INTEGER NOT NULL,
    difficulty_energy      DOUBLE PRECISION NOT NULL,
    min_diversity          DOUBLE PRECISION NOT NULL,
    min_solutions          INTEGER NOT NULL,
    substrate_block_number TEXT,
    substrate_block_hash   TEXT,
    substrate_parent_hash  TEXT,
    extrinsics_root        TEXT,
    state_root             TEXT,
    finalized              BOOLEAN NOT NULL DEFAULT FALSE,
    is_canonical           BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (epoch, block_index)
  );
  CREATE INDEX idx_blocks_canonical_ts ON blocks(is_canonical, timestamp);
  CREATE INDEX idx_blocks_substrate_hash ON blocks(substrate_block_hash);
  CREATE INDEX idx_blocks_miner_energy ON blocks(miner_id, energy, timestamp DESC);

  CREATE TABLE epoch_status (
    epoch         TEXT PRIMARY KEY,
    status        TEXT NOT NULL CHECK (status IN ('live','stale_fork')),
    chain_anchor  TEXT
  );

  CREATE TABLE nodes_snapshot (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    payload JSONB NOT NULL
  );

  CREATE TABLE indexer_cursors (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload JSONB NOT NULL
  );

  CREATE TABLE indexer_etags (
    endpoint TEXT PRIMARY KEY,
    etag     TEXT NOT NULL
  );

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  INSERT INTO meta (key, value) VALUES ('schema_version', '5');

  -- One row exercising the substrate_* NOT NULL backfill: substrate_block_number
  -- is left NULL, substrate_block_hash is non-NULL, parent_hash is NULL.
  INSERT INTO blocks (
    epoch, block_index, block_hash, timestamp, previous_hash, miner_id,
    miner_category, ecdsa_public_key, energy, diversity, num_valid_solutions,
    mining_time, nonce, num_nodes, num_edges, difficulty_energy,
    min_diversity, min_solutions, substrate_block_hash
  ) VALUES (
    '0xepoch1', 0, '0xpow-legacy-1', 1700000000, '0xprev', '5GPP',
    'CPU', '0xpub', -2500, 0.4, 5,
    6.0, 42, 100, 200, -2500, 0.2, 5, '0xsub1'
  );
`;

async function resetPublicSchema(sql: Sql): Promise<void> {
  // Drop everything in the public schema so the seed can recreate the v5
  // shape from scratch. This is destructive — only used against TEST_URL.
  await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
}

interface TableNameRow {
  tablename: string;
}

interface ColumnRow {
  column_name: string;
  is_nullable: "YES" | "NO";
}

interface MetaRow {
  value: string | null;
}

interface PkColumnRow {
  attname: string;
}

interface BlockSampleRow {
  block_hash: string;
  substrate_block_number: string | number;
  substrate_block_hash: string;
  substrate_parent_hash: string;
  quality_milli: number;
  reward: string | number;
}

maybeDescribe("v6 migration applied to a v5 fixture", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(TEST_URL as string, { max: 1 });
    await resetPublicSchema(sql);
    await sql.unsafe(V5_SEED_SQL);
    const migration = readFileSync(V6_SQL_PATH, "utf8");
    await sql.unsafe(migration);
  });

  afterAll(async () => {
    await resetPublicSchema(sql).catch(() => {});
    await sql.end({ timeout: 5 });
  });

  test("legacy tables are dropped", async () => {
    const rows = await sql<TableNameRow[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const names = rows.map((r) => r.tablename);
    expect(names).not.toContain("epoch_status");
    expect(names).not.toContain("nodes_snapshot");
    expect(names).not.toContain("self_address");
    expect(names).not.toContain("indexer_cursors");
    expect(names).not.toContain("indexer_etags");
  });

  test("miner_hardware table created", async () => {
    const rows = await sql<TableNameRow[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    expect(rows.map((r) => r.tablename)).toContain("miner_hardware");
  });

  test("blocks PK is now block_hash", async () => {
    const rows = await sql<PkColumnRow[]>`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'blocks'::regclass AND i.indisprimary
    `;
    expect(rows.map((r) => r.attname)).toEqual(["block_hash"]);
  });

  test("v6 block columns added, legacy block columns removed", async () => {
    const rows = await sql<ColumnRow[]>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'blocks'
    `;
    const names = rows.map((r) => r.column_name);
    // v6 additions
    expect(names).toContain("quality_milli");
    expect(names).toContain("reward");
    // legacy drops
    expect(names).not.toContain("epoch");
    expect(names).not.toContain("block_index");
    expect(names).not.toContain("miner_category");
    expect(names).not.toContain("ecdsa_public_key");
    expect(names).not.toContain("is_canonical");
    expect(names).not.toContain("extrinsics_root");
    expect(names).not.toContain("state_root");
    expect(names).not.toContain("previous_hash");
    // substrate_* are now NOT NULL
    const nullable = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(nullable.substrate_block_number).toBe("NO");
    expect(nullable.substrate_block_hash).toBe("NO");
    expect(nullable.substrate_parent_hash).toBe("NO");
  });

  test("legacy row's substrate_* fields are backfilled with sentinels", async () => {
    const rows = await sql<BlockSampleRow[]>`
      SELECT block_hash, substrate_block_number, substrate_block_hash,
             substrate_parent_hash, quality_milli, reward
      FROM blocks WHERE block_hash = '0xpow-legacy-1'
    `;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("unreachable");
    // NULL substrate_block_number was backfilled with 0 (text in v5; the
    // column type stays TEXT after the migration so it reads back as "0").
    expect(String(row.substrate_block_number)).toBe("0");
    // Non-NULL substrate_block_hash is preserved.
    expect(row.substrate_block_hash).toBe("0xsub1");
    // NULL substrate_parent_hash was backfilled with the empty-string sentinel.
    expect(row.substrate_parent_hash).toBe("");
    // New columns took their defaults.
    expect(Number(row.quality_milli)).toBe(0);
    expect(String(row.reward)).toBe("0");
  });

  test("schema_version is 6", async () => {
    const rows = await sql<MetaRow[]>`
      SELECT value FROM meta WHERE key = 'schema_version'
    `;
    expect(rows[0]?.value).toBe("6");
  });
});
