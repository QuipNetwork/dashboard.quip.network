// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// Pipeline-indexer groundwork (spec §9, docs/superpowers/specs/
// 2026-07-02-indexer-redesign-design.md). Two forward-only concerns:
//
//   (1) `validator_authorship_blocks` — row-per-(validator, block) authorship
//       facts. Replaces the write path of the `validator_authorship` counter
//       (`blocks_authored + 1`), whose increments double-count on every crash
//       replay, reconnect replay, or reconciler re-visit. The counter table is
//       KEPT: it floors the union read during the historical walk and is
//       repurposed as the derived summary cache after cutover — never dropped.
//       `idx_vab_validator_winner` serves the per-validator count aggregates
//       (union read + summary recompute); `idx_vab_block` serves the
//       reconciler's per-chunk sample checks.
//
//   (2) `difficulty_history.source` — 'block' (derived from a winner block by
//       the difficulty plugin) vs 'poll' (live head snapshot). Gives the two
//       writers ownership of their own rows: `--reindex difficulty` deletes
//       only 'block' rows, and the drift cross-check filters on it. Existing
//       rows backfill as 'poll' via the default — historically every row came
//       from the poll path.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("validator_authorship_blocks")
    .ifNotExists()
    .addColumn("validator", "text", (c) => c.notNull())
    .addColumn("block_number", "numeric", (c) => c.notNull())
    .addColumn("timestamp", "timestamptz", (c) => c.notNull())
    .addColumn("had_winner", "boolean", (c) => c.notNull())
    .addPrimaryKeyConstraint("validator_authorship_blocks_pkey", ["validator", "block_number"])
    .execute();

  const statements = [
    `create index if not exists idx_vab_validator_winner
       on validator_authorship_blocks(validator, had_winner)`,
    `create index if not exists idx_vab_block
       on validator_authorship_blocks(block_number)`,
    `alter table difficulty_history
       add column if not exists source text not null default 'poll'`,
  ];
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}
