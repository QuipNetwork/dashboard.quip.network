// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed difficulty history (spec §10.5, task #24): everything at or
// after `since` (ascending, ready to chart left-to-right) plus one anchor row
// strictly before it. Rows exist only at winner blocks and on poll-value
// changes, so a window shorter than the current stable-difficulty stretch
// would otherwise be empty — the anchor lets every window render the
// prevailing step. Feeds the price-panel range selector (1h…All Time).

import type { Hono } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { DifficultyHistoryResponse } from "@quip/shared/telemetry";

export function registerDifficultyHistoryRoute(app: Hono, db: DatabaseAdapter): void {
  app.get("/api/difficulty-history", async (c) => {
    const since = c.req.query("since");
    if (!since || Number.isNaN(Date.parse(since))) {
      return c.json(
        { error: "query parameter `since` must be an ISO 8601 timestamp" },
        400,
      );
    }
    const [rows, anchor] = await Promise.all([
      db.getDifficultySince(since),
      db.getDifficultyAnchorBefore(since),
    ]);
    return c.json({ since, anchor, rows } satisfies DifficultyHistoryResponse);
  });
}
