// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

import type { MigrationDialect } from "../api/db/migrator";

// Baseline schema. Reproduces the dashboard's existing dual-dialect tables so a
// fresh DB is fully created and an already-populated (pre-migration) DB no-ops
// via IF NOT EXISTS and is recorded as the baseline. Forward-only: no down.
export async function up(db: Kysely<unknown>, dialect: MigrationDialect): Promise<void> {
  const pg = dialect === "postgres";
  const u64 = sql.raw(pg ? "numeric" : "text");
  const unixTs = sql.raw(pg ? "bigint" : "integer");
  const float = sql.raw(pg ? "double precision" : "real");
  const big = sql.raw(pg ? "bigint" : "integer");
  const isoTs = sql.raw(pg ? "timestamptz" : "text");
  const json = sql.raw(pg ? "jsonb" : "text");
  const boolType = sql.raw(pg ? "boolean" : "integer");
  const boolDefault = sql.raw(pg ? "false" : "0");

  // Clean worker-state tables retired before proper migrations existed.
  for (const t of [
    "epoch_status",
    "nodes_snapshot",
    "self_address",
    "indexer_cursors",
    "indexer_etags",
    "proof_attempts",
    "indexer_state",
  ]) {
    await sql.raw(`drop table if exists ${t}${pg ? " cascade" : ""}`).execute(db);
  }

  await db.schema
    .createTable("blocks")
    .ifNotExists()
    .addColumn("block_hash", "text", (c) => c.primaryKey())
    .addColumn("substrate_block_number", u64, (c) => c.notNull())
    .addColumn("substrate_block_hash", "text", (c) => c.notNull())
    .addColumn("substrate_parent_hash", "text", (c) => c.notNull())
    .addColumn("timestamp", unixTs, (c) => c.notNull())
    .addColumn("miner_id", "text", (c) => c.notNull())
    .addColumn("energy", float, (c) => c.notNull())
    .addColumn("diversity", float, (c) => c.notNull())
    .addColumn("num_valid_solutions", "integer", (c) => c.notNull())
    .addColumn("mining_time", float, (c) => c.notNull())
    .addColumn("reward", u64, (c) => c.notNull())
    .addColumn("nonce", u64, (c) => c.notNull())
    .addColumn("num_nodes", "integer", (c) => c.notNull())
    .addColumn("num_edges", "integer", (c) => c.notNull())
    .addColumn("difficulty_energy", float, (c) => c.notNull())
    .addColumn("min_diversity", float, (c) => c.notNull())
    .addColumn("min_solutions", "integer", (c) => c.notNull())
    .addColumn("finalized", boolType, (c) => c.notNull().defaultTo(boolDefault))
    .execute();

  await db.schema
    .createTable("miner_hardware")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("node_id", "text", (c) => c.notNull())
    .addColumn("miners", json, (c) => c.notNull())
    .addColumn("primary_type", "text", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("observed_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("meta")
    .ifNotExists()
    .addColumn("key", "text", (c) => c.primaryKey())
    .addColumn("value", "text")
    .execute();

  await db.schema
    .createTable("chain_head")
    .ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().check(sql`id = 1`))
    .addColumn("best_block_number", u64, (c) => c.notNull())
    .addColumn("best_block_hash", "text", (c) => c.notNull())
    .addColumn("finalized_block_number", u64, (c) => c.notNull())
    .addColumn("finalized_block_hash", "text", (c) => c.notNull())
    .addColumn("finality_lag", "integer", (c) => c.notNull())
    .addColumn("winning_solutions_count", big)
    .addColumn("spec_name", "text", (c) => c.notNull())
    .addColumn("spec_version", "integer", (c) => c.notNull())
    .addColumn("transaction_version", "integer", (c) => c.notNull())
    .addColumn("impl_name", "text", (c) => c.notNull())
    .addColumn("last_runtime_upgrade", u64)
    .addColumn("updated_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("babe_epochs")
    .ifNotExists()
    .addColumn("epoch_index", "integer", (c) => c.primaryKey())
    .addColumn("current_slot", u64, (c) => c.notNull())
    .addColumn("epoch_start_slot", u64, (c) => c.notNull())
    .addColumn("slots_per_epoch", "integer", (c) => c.notNull())
    .addColumn("current_slot_in_epoch", "integer", (c) => c.notNull())
    .addColumn("authority_count", "integer", (c) => c.notNull())
    .addColumn("is_current", boolType, (c) => c.notNull().defaultTo(boolDefault))
    .addColumn("updated_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("babe_authorities")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.notNull())
    .addColumn("epoch_index", "integer", (c) => c.notNull())
    .addColumn("display_name", "text")
    .addColumn("is_active", boolType, (c) => c.notNull().defaultTo(boolDefault))
    .addColumn("updated_at", isoTs, (c) => c.notNull())
    .addPrimaryKeyConstraint("babe_authorities_pkey", ["account_id", "epoch_index"])
    .execute();

  await db.schema
    .createTable("chain_miners")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("deposit", u64, (c) => c.notNull())
    .addColumn("proofs_submitted", u64, (c) => c.notNull())
    .addColumn("proofs_won", u64, (c) => c.notNull())
    .addColumn("rewards_earned", u64, (c) => c.notNull())
    .addColumn("updated_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("difficulty_history")
    .ifNotExists()
    .addColumn("observed_at_block", u64, (c) => c.primaryKey())
    .addColumn("difficulty_energy", float, (c) => c.notNull())
    .addColumn("min_diversity", float, (c) => c.notNull())
    .addColumn("min_solutions", "integer", (c) => c.notNull())
    .addColumn("observed_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("validator_authorship")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("blocks_authored", big, (c) => c.notNull().defaultTo(0))
    .addColumn("blocks_authored_with_pow", big, (c) => c.notNull().defaultTo(0))
    .addColumn("last_authored_block", u64, (c) => c.notNull())
    .addColumn("last_authored_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("node_descriptors")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("block_number", u64, (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addColumn("extrinsic_index", "integer", (c) => c.notNull())
    .addColumn("block_timestamp", unixTs, (c) => c.notNull())
    .addColumn("first_block_timestamp", unixTs, (c) => c.notNull())
    .addColumn("descriptor", json, (c) => c.notNull())
    .addColumn("observed_at", isoTs, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("mining_submissions")
    .ifNotExists()
    .addColumn("miner_id", "text", (c) => c.notNull())
    .addColumn("solution_number", big, (c) => c.notNull())
    .addColumn("ts_ns", u64, (c) => c.notNull())
    .addColumn("energy_milli", big, (c) => c.notNull())
    .addColumn("diversity_milli", big, (c) => c.notNull())
    .addColumn("threshold_milli", big, (c) => c.notNull())
    .addColumn("last_proof_block_hash", "text", (c) => c.notNull())
    .addColumn("extrinsic_hash", "text")
    .addColumn("chain_block_hash", "text")
    .addColumn("chain_block_number", u64)
    .addColumn("pow_sequence", big)
    .addColumn("outcome", "text", (c) => c.notNull())
    .addColumn("attempt_count", "integer", (c) => c.notNull())
    .addColumn("best_energy_milli", big, (c) => c.notNull())
    .addColumn("num_valid", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("miner_type", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("qpu_access_time_us", big, (c) => c.notNull().defaultTo(0))
    .addColumn("observed_at", isoTs, (c) => c.notNull())
    .addPrimaryKeyConstraint("mining_submissions_pkey", ["miner_id", "solution_number"])
    .execute();

  const blockNumberDesc = pg
    ? "substrate_block_number desc"
    : "cast(substrate_block_number as integer) desc";
  const descriptorBlockDesc = pg ? "block_number desc" : "cast(block_number as integer) desc";
  const indexes = [
    `create index if not exists idx_blocks_substrate_number on blocks(${blockNumberDesc})`,
    `create index if not exists idx_blocks_miner_id on blocks(miner_id, ${blockNumberDesc})`,
    `create index if not exists idx_blocks_timestamp on blocks(timestamp desc)`,
    `create index if not exists idx_babe_epochs_current on babe_epochs(is_current)${pg ? " where is_current" : ""}`,
    `create index if not exists idx_babe_authorities_active on babe_authorities(epoch_index, is_active)`,
    `create index if not exists idx_difficulty_history_observed on difficulty_history(observed_at desc)`,
    `create index if not exists idx_validator_authorship_authored on validator_authorship(blocks_authored desc)`,
    `create index if not exists idx_node_descriptors_block on node_descriptors(${descriptorBlockDesc})`,
    `create index if not exists idx_mining_submissions_miner_recent on mining_submissions(miner_id, solution_number desc)`,
  ];
  for (const stmt of indexes) await sql.raw(stmt).execute(db);
}
