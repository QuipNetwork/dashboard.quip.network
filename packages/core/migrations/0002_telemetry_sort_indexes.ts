// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type Kysely } from "kysely";

// Additive indexes backing the unindexed sorts/filters on the per-request
// `/api/telemetry` read path. Each full-table scan below grows with network
// size and runs on every dashboard poll; these let Postgres serve the order
// from an index instead of sorting the whole table each time. Forward-only,
// `if not exists`, no data change.
export async function up(db: Kysely<unknown>): Promise<void> {
  const indexes = [
    // getChainMiners(): order by rewards_earned desc.
    `create index if not exists idx_chain_miners_rewards on chain_miners(rewards_earned desc)`,
    // getAllMinerHardware(): order by observed_at desc.
    `create index if not exists idx_miner_hardware_observed on miner_hardware(observed_at desc)`,
    // getAllNodeDescriptors(): order by coalesce(descriptor->>'nodeName', account_id).
    `create index if not exists idx_node_descriptors_name on node_descriptors((coalesce(descriptor->>'nodeName', account_id)))`,
    // countMiningSubmissionsWithAttempts(): filter miner_id where attempt_count > 0.
    `create index if not exists idx_mining_submissions_attempts on mining_submissions(miner_id) where attempt_count > 0`,
  ];
  for (const stmt of indexes) await sql.raw(stmt).execute(db);
}
