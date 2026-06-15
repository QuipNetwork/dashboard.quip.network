// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely } from "kysely";

import { SqliteDriverDialect } from "./kysely-sqlite-dialect";
import { migrateToLatest, migrationStatus, pendingMigrations } from "./migrator";
import { Database, type Database as Db } from "./sqlite-driver";
import { up as applyInitialSchema } from "../../migrations/0001_initial";

// One representative row per owned table, exercising every column (including
// the u64-as-string, milli-unit, and JSON-text conventions) so a regression
// that drops or rewrites data on adoption is caught.
const LEGACY_SEED: Array<[string, Record<string, unknown>]> = [
  [
    "blocks",
    {
      block_hash: "0xblock",
      substrate_block_number: "100",
      substrate_block_hash: "0xsub",
      substrate_parent_hash: "0xparent",
      timestamp: 1700000000,
      miner_id: "5Miner",
      energy: 1.5,
      diversity: 2.5,
      num_valid_solutions: 3,
      mining_time: 4.5,
      reward: "1000",
      nonce: "42",
      num_nodes: 10,
      num_edges: 20,
      difficulty_energy: 5.5,
      min_diversity: 0.5,
      min_solutions: 1,
      finalized: 1,
    },
  ],
  [
    "miner_hardware",
    {
      account_id: "5Acc",
      node_id: "node-1",
      miners: '[{"type":"CUDA","count":2}]',
      primary_type: "CUDA",
      source: "self",
      observed_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  ["meta", { key: "self_address", value: "5Self" }],
  [
    "chain_head",
    {
      id: 1,
      best_block_number: "200",
      best_block_hash: "0xbest",
      finalized_block_number: "190",
      finalized_block_hash: "0xfinal",
      finality_lag: 10,
      winning_solutions_count: 5,
      spec_name: "quip",
      spec_version: 21,
      transaction_version: 1,
      impl_name: "quip-node",
      last_runtime_upgrade: "180",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "babe_epochs",
    {
      epoch_index: 7,
      current_slot: "1000",
      epoch_start_slot: "900",
      slots_per_epoch: 100,
      current_slot_in_epoch: 50,
      authority_count: 4,
      is_current: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "babe_authorities",
    {
      account_id: "5Auth",
      epoch_index: 7,
      display_name: "Validator One",
      is_active: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "chain_miners",
    {
      account_id: "5Miner",
      deposit: "10000",
      proofs_submitted: "50",
      proofs_won: "5",
      rewards_earned: "2500",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "difficulty_history",
    {
      observed_at_block: "150",
      difficulty_energy: 5.5,
      min_diversity: 0.5,
      min_solutions: 1,
      observed_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "validator_authorship",
    {
      account_id: "5Auth",
      blocks_authored: 100,
      blocks_authored_with_pow: 80,
      last_authored_block: "199",
      last_authored_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "node_descriptors",
    {
      account_id: "5Acc",
      block_number: "120",
      block_hash: "0xnode",
      extrinsic_index: 2,
      block_timestamp: 1700000000,
      first_block_timestamp: 1699000000,
      descriptor: '{"name":"node-1"}',
      observed_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  [
    "mining_submissions",
    {
      miner_id: "5Miner",
      solution_number: 42,
      ts_ns: "1700000000000000000",
      energy_milli: 1500,
      diversity_milli: 2500,
      threshold_milli: 1000,
      last_proof_block_hash: "0xlastproof",
      extrinsic_hash: "0xext",
      chain_block_hash: "0xchain",
      chain_block_number: "100",
      pow_sequence: 49,
      outcome: "won",
      attempt_count: 7,
      best_energy_milli: 1400,
      num_valid: 3,
      miner_type: "CUDA",
      qpu_access_time_us: 0,
      observed_at: "2026-01-01T00:00:00.000Z",
    },
  ],
];

function insertRow(db: Db, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`).run(
    ...cols.map((c) => row[c]),
  );
}

function snapshot(db: Db): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [table] of LEGACY_SEED) {
    out[table] = db.query(`SELECT * FROM ${table} ORDER BY 1`).all();
  }
  return out;
}

const ALL_TABLES = [
  "blocks",
  "miner_hardware",
  "meta",
  "chain_head",
  "babe_epochs",
  "babe_authorities",
  "chain_miners",
  "difficulty_history",
  "validator_authorship",
  "node_descriptors",
  "mining_submissions",
];

let dir: string;
let raw: Db;
let k: Kysely<any>;

function tableNames(): string[] {
  return raw
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrator-"));
  raw = new Database(join(dir, "t.db"), { create: true });
  k = new Kysely({ dialect: new SqliteDriverDialect(raw) });
});

afterEach(async () => {
  await k.destroy();
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrator (sqlite)", () => {
  it("applies the baseline to a fresh DB and records it in the ledger", async () => {
    const before = await pendingMigrations(k, "sqlite");
    expect(before).toEqual(["0001_initial"]);

    const { applied } = await migrateToLatest(k, "sqlite");
    expect(applied).toEqual(["0001_initial"]);

    const tables = tableNames();
    for (const t of ALL_TABLES) expect(tables).toContain(t);
    expect(tables).toContain("kysely_migration");

    const status = await migrationStatus(k, "sqlite");
    expect(status).toEqual([{ name: "0001_initial", applied: true, executedAt: expect.any(Date) }]);
    expect(await pendingMigrations(k, "sqlite")).toEqual([]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    await migrateToLatest(k, "sqlite");
    const { applied } = await migrateToLatest(k, "sqlite");
    expect(applied).toEqual([]);
  });

  it("adopts a fully-populated pre-migration DB with no data loss or corruption", async () => {
    // Simulate the realistic prod state: the full current schema, populated
    // across every table, but no migration ledger (the old drop-recreate model
    // never created kysely_migration). Building the schema via the migration's
    // up() directly — without recording it — is exactly that state.
    await applyInitialSchema(k, "sqlite");
    for (const [table, row] of LEGACY_SEED) insertRow(raw, table, row);
    expect(await pendingMigrations(k, "sqlite")).toEqual(["0001_initial"]);

    const before = snapshot(raw);

    const { applied } = await migrateToLatest(k, "sqlite");
    expect(applied).toEqual(["0001_initial"]);

    // Every row in every table is byte-for-byte identical after adoption.
    expect(snapshot(raw)).toEqual(before);
    for (const [table, row] of LEGACY_SEED) {
      const stored = (before[table] ?? []) as Array<Record<string, unknown>>;
      expect(stored).toHaveLength(1);
      for (const col of Object.keys(row)) expect(stored[0]?.[col]).toEqual(row[col]);
    }
    expect(await pendingMigrations(k, "sqlite")).toEqual([]);
  });
});
