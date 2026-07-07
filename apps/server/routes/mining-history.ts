// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed mining history: slim winner-block rows at/after `since`
// (ascending, ready to chart left-to-right). Mirrors /api/difficulty-history's
// windowing but needs no anchor — mining time is a scatter of discrete wins,
// not a step function. Feeds the "Mining per QBlock" range selector.

import type { Hono } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { MiningHistoryResponse } from "@quip/shared/telemetry";

export function registerMiningHistoryRoute(app: Hono, db: DatabaseAdapter): void {
  app.get("/api/mining-history", async (c) => {
    const since = c.req.query("since");
    if (!since || Number.isNaN(Date.parse(since))) {
      return c.json({ error: "query parameter `since` must be an ISO 8601 timestamp" }, 400);
    }
    const rows = await db.getMiningHistorySince(since);
    return c.json({ since, rows } satisfies MiningHistoryResponse);
  });
}
