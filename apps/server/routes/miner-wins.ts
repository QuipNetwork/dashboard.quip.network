// SPDX-License-Identifier: AGPL-3.0-or-later
//
// All-time per-miner win aggregates from the indexed `blocks` table, wins
// descending. One `GROUP BY miner_id` in the adapter serves every "qblocks
// won" surface (leaderboard, rank-adjacent miners, miner info panes) so the
// numbers agree by construction. Lifetime on-chain `proofsWon` is a distinct
// measure and stays on /api/telemetry's `chainMiners`.

import type { Hono } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { MinerWinsResponse } from "@quip/shared/telemetry";

export function registerMinerWinsRoute(app: Hono, db: DatabaseAdapter): void {
  app.get("/api/miner-wins", async (c) => {
    const rows = await db.getMinerWins();
    return c.json({ rows } satisfies MinerWinsResponse);
  });
}
