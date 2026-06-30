// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// Two forward-only concerns, both idempotent and down-less:
//
//   (1) Reconcile `node_descriptors`. Pre-monorepo dashboards created this
//       table under the SAME migration name (`0001_initial`) but with an older
//       column set (`payload_hash`, no `extrinsic_index`). Because Kysely tracks
//       migrations by name and `0001_initial` was already recorded, the rebuilt
//       `0001_initial` (guarded with `if not exists`) never reshaped the table,
//       so the descriptor worker's INSERT failed every scan ("column block_hash
//       does not exist") and the registry froze at stale rows. `node_descriptors`
//       is a latest-per-account snapshot the worker fully rebuilds at each
//       finalized head, so dropping and recreating it is safe and self-heals any
//       drifted deployment. The indexes from 0001/0002 are recreated here since
//       the drop takes them with it.
//
//   (2) Tag analytics by topology. `blocks` and `difficulty_history` gain a
//       nullable `topology_hash` so the API can scope charts to the chain's
//       current default topology. When the default topology changes, rows tagged
//       with the prior hash fall out of the scoped views and the charts reset —
//       without destroying history. Nullable: rows written before this migration
//       (and any pre-v0.2 chain with no default topology) carry NULL and are
//       simply excluded from the scoped views.
export async function up(db: Kysely<unknown>): Promise<void> {
  // (1) Rebuild node_descriptors to the canonical schema.
  await sql.raw(`drop table if exists node_descriptors`).execute(db);
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
  await sql
    .raw(
      `create index if not exists idx_node_descriptors_block on node_descriptors(block_number desc)`,
    )
    .execute(db);
  await sql
    .raw(
      `create index if not exists idx_node_descriptors_name on node_descriptors((coalesce(descriptor->>'nodeName', account_id)))`,
    )
    .execute(db);

  // (2) Per-topology analytics tags.
  await sql.raw(`alter table blocks add column if not exists topology_hash text`).execute(db);
  await sql
    .raw(`alter table difficulty_history add column if not exists topology_hash text`)
    .execute(db);
  await sql
    .raw(`create index if not exists idx_blocks_topology on blocks(topology_hash)`)
    .execute(db);
}
