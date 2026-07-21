// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// `qblock_participation` — one row per (qblock, account) for EVERY node that
// declared it was racing a qblock, across all device kinds. Sourced from
// pallet-miner-registry's `ParticipantsByQBlock` reverse index (runtime API
// `participants_by_qblock`) by the `participation` block-plugin. This is the
// participant-level counterpart to `blocks`, which only holds the single
// winner per qblock — the per-type compute/energy aggregate is built from it.
//
// Pure chain facts: `kind` is the raw MinerKind variant, `budget_seconds` the
// node's declared budget (nullable — CPU/GPU often omit it). Device-access
// time and energy are derived downstream, never stored here, so the time model
// can change without a re-index. PK (qblock_id, account) makes the plugin's
// upsert idempotent (participation is one-per-account-per-qblock on chain).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      // qblock_id is numeric to match blocks.qblock_id (0003) and
      // mining_submissions.solution_number, so the compute-aggregate join is a
      // clean numeric = numeric with no per-row casts. Values still cross the
      // adapter boundary as u64 strings (postgres returns numeric as text).
      `create table if not exists qblock_participation (
        qblock_id numeric not null,
        account text not null,
        kind text not null,
        budget_seconds integer,
        block_number text not null,
        primary key (qblock_id, account)
      )`,
    )
    .execute(db);
  // Reads are per-qblock (aggregate + charts); PK leads with qblock_id so the
  // range scan is already covered, but an explicit index keeps intent clear
  // and survives any future PK reordering.
  await sql
    .raw(
      `create index if not exists idx_qblock_participation_qblock
        on qblock_participation (qblock_id)`,
    )
    .execute(db);
}
