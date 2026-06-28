// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// Baseline schema (Postgres). Reproduces the dashboard's tables with IF NOT
// EXISTS so a fresh DB is fully created and an already-populated (pre-migration)
// DB no-ops and is recorded as the baseline. Forward-only: no down.
export async function up(db: Kysely<unknown>): Promise<void> {
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
    await sql.raw(`drop table if exists ${t} cascade`).execute(db);
  }

  await db.schema
    .createTable("blocks")
    .ifNotExists()
    .addColumn("block_hash", "text", (c) => c.primaryKey())
    .addColumn("substrate_block_number", "numeric", (c) => c.notNull())
    .addColumn("substrate_block_hash", "text", (c) => c.notNull())
    .addColumn("substrate_parent_hash", "text", (c) => c.notNull())
    .addColumn("timestamp", "bigint", (c) => c.notNull())
    .addColumn("miner_id", "text", (c) => c.notNull())
    .addColumn("energy", "double precision", (c) => c.notNull())
    .addColumn("diversity", "double precision", (c) => c.notNull())
    .addColumn("num_valid_solutions", "integer", (c) => c.notNull())
    .addColumn("mining_time", "double precision", (c) => c.notNull())
    .addColumn("reward", "numeric", (c) => c.notNull())
    .addColumn("nonce", "numeric", (c) => c.notNull())
    .addColumn("num_nodes", "integer", (c) => c.notNull())
    .addColumn("num_edges", "integer", (c) => c.notNull())
    .addColumn("difficulty_energy", "double precision", (c) => c.notNull())
    .addColumn("min_diversity", "double precision", (c) => c.notNull())
    .addColumn("min_solutions", "integer", (c) => c.notNull())
    .addColumn("finalized", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();

  await db.schema
    .createTable("miner_hardware")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("node_id", "text", (c) => c.notNull())
    .addColumn("miners", "jsonb", (c) => c.notNull())
    .addColumn("primary_type", "text", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("observed_at", "timestamptz", (c) => c.notNull())
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
    .addColumn("best_block_number", "numeric", (c) => c.notNull())
    .addColumn("best_block_hash", "text", (c) => c.notNull())
    .addColumn("finalized_block_number", "numeric", (c) => c.notNull())
    .addColumn("finalized_block_hash", "text", (c) => c.notNull())
    .addColumn("finality_lag", "integer", (c) => c.notNull())
    .addColumn("winning_solutions_count", "bigint")
    .addColumn("spec_name", "text", (c) => c.notNull())
    .addColumn("spec_version", "integer", (c) => c.notNull())
    .addColumn("transaction_version", "integer", (c) => c.notNull())
    .addColumn("impl_name", "text", (c) => c.notNull())
    .addColumn("last_runtime_upgrade", "numeric")
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("babe_epochs")
    .ifNotExists()
    .addColumn("epoch_index", "integer", (c) => c.primaryKey())
    .addColumn("current_slot", "numeric", (c) => c.notNull())
    .addColumn("epoch_start_slot", "numeric", (c) => c.notNull())
    .addColumn("slots_per_epoch", "integer", (c) => c.notNull())
    .addColumn("current_slot_in_epoch", "integer", (c) => c.notNull())
    .addColumn("authority_count", "integer", (c) => c.notNull())
    .addColumn("is_current", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("babe_authorities")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.notNull())
    .addColumn("epoch_index", "integer", (c) => c.notNull())
    .addColumn("display_name", "text")
    .addColumn("is_active", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .addPrimaryKeyConstraint("babe_authorities_pkey", ["account_id", "epoch_index"])
    .execute();

  await db.schema
    .createTable("chain_miners")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("deposit", "numeric", (c) => c.notNull())
    .addColumn("proofs_submitted", "numeric", (c) => c.notNull())
    .addColumn("proofs_won", "numeric", (c) => c.notNull())
    .addColumn("rewards_earned", "numeric", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("difficulty_history")
    .ifNotExists()
    .addColumn("observed_at_block", "numeric", (c) => c.primaryKey())
    .addColumn("difficulty_energy", "double precision", (c) => c.notNull())
    .addColumn("min_diversity", "double precision", (c) => c.notNull())
    .addColumn("min_solutions", "integer", (c) => c.notNull())
    .addColumn("observed_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("validator_authorship")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("blocks_authored", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("blocks_authored_with_pow", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("last_authored_block", "numeric", (c) => c.notNull())
    .addColumn("last_authored_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("node_descriptors")
    .ifNotExists()
    .addColumn("account_id", "text", (c) => c.primaryKey())
    .addColumn("block_number", "numeric", (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addColumn("extrinsic_index", "integer", (c) => c.notNull())
    .addColumn("block_timestamp", "bigint", (c) => c.notNull())
    .addColumn("first_block_timestamp", "bigint", (c) => c.notNull())
    .addColumn("descriptor", "jsonb", (c) => c.notNull())
    .addColumn("observed_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("mining_submissions")
    .ifNotExists()
    .addColumn("miner_id", "text", (c) => c.notNull())
    .addColumn("solution_number", "bigint", (c) => c.notNull())
    .addColumn("ts_ns", "numeric", (c) => c.notNull())
    .addColumn("energy_milli", "bigint", (c) => c.notNull())
    .addColumn("diversity_milli", "bigint", (c) => c.notNull())
    .addColumn("threshold_milli", "bigint", (c) => c.notNull())
    .addColumn("last_proof_block_hash", "text", (c) => c.notNull())
    .addColumn("extrinsic_hash", "text")
    .addColumn("chain_block_hash", "text")
    .addColumn("chain_block_number", "numeric")
    .addColumn("pow_sequence", "bigint")
    .addColumn("outcome", "text", (c) => c.notNull())
    .addColumn("attempt_count", "integer", (c) => c.notNull())
    .addColumn("best_energy_milli", "bigint", (c) => c.notNull())
    .addColumn("num_valid", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("miner_type", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("qpu_access_time_us", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("observed_at", "timestamptz", (c) => c.notNull())
    .addPrimaryKeyConstraint("mining_submissions_pkey", ["miner_id", "solution_number"])
    .execute();

  const indexes = [
    `create index if not exists idx_blocks_substrate_number on blocks(substrate_block_number desc)`,
    `create index if not exists idx_blocks_miner_id on blocks(miner_id, substrate_block_number desc)`,
    `create index if not exists idx_blocks_timestamp on blocks(timestamp desc)`,
    `create index if not exists idx_babe_epochs_current on babe_epochs(is_current) where is_current`,
    `create index if not exists idx_babe_authorities_active on babe_authorities(epoch_index, is_active)`,
    `create index if not exists idx_difficulty_history_observed on difficulty_history(observed_at desc)`,
    `create index if not exists idx_validator_authorship_authored on validator_authorship(blocks_authored desc)`,
    `create index if not exists idx_node_descriptors_block on node_descriptors(block_number desc)`,
    `create index if not exists idx_mining_submissions_miner_recent on mining_submissions(miner_id, solution_number desc)`,
  ];
  for (const stmt of indexes) await sql.raw(stmt).execute(db);
}
