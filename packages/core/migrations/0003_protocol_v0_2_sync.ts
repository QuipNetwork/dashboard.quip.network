// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// quip-protocol-rs v0.2 sync: surfaces three new chain data points.
//   (1) `blocks.qblock_id` — the monotonic qblock id from the v0.2
//       `BlockWinner` event, the per-block "solution number". NOT NULL with a
//       '0' default so the column is valid on an already-populated `blocks`
//       table; the substrate worker repopulates real values as it re-observes
//       winning blocks (backfill is idempotent on block_hash).
//   (2) `chain_head.current_qblock_id` + `current_qblock_participants` — the
//       in-flight qblock (QBlockCount + 1) and how many miners declared
//       participation on it (MinerRegistry runtime API). Nullable: the single
//       chain_head row is overwritten on the next head event.
// Forward-only, `if not exists`/idempotent, no down.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`alter table blocks add column if not exists qblock_id numeric not null default 0`)
    .execute(db);
  await sql
    .raw(`alter table chain_head add column if not exists current_qblock_id numeric`)
    .execute(db);
  await sql
    .raw(`alter table chain_head add column if not exists current_qblock_participants integer`)
    .execute(db);
}
