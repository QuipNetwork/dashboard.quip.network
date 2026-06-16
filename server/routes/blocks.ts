// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Hono } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

const DEFAULT_BLOCKS_PAGE = 100;
const MAX_BLOCKS_PAGE = 500;

export function registerBlocksRoute(app: Hono, db: DatabaseAdapter): void {
  app.get("/api/blocks", async (c) => {
    const rawLimit = Number(c.req.query("limit") ?? DEFAULT_BLOCKS_PAGE);
    const rawOffset = Number(c.req.query("offset") ?? 0);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_BLOCKS_PAGE)
      : DEFAULT_BLOCKS_PAGE;
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
    const blocks = await db.getRecentBlocks(limit, offset);
    return c.json({ blocks });
  });
}
