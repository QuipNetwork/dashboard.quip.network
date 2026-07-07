// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// `blocks.device_access_time_us` — the winner's self-reported device compute
// time for the winning proof (runtime 112+ QBlock field), µs. Nullable and
// no default, mirroring `topology_hash` (0004): pre-runtime-112 chains and
// any winner that didn't report it carry NULL, and the winners plugin is the
// only writer — a reindex backfills history for free once it starts
// persisting the field (spec §5 checklist).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`alter table blocks add column if not exists device_access_time_us bigint`)
    .execute(db);
}
