// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Hono } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

export function registerHealthRoute(app: Hono, db: DatabaseAdapter): void {
  app.get("/api/health", async (c) => {
    // v6 drops the dual-cursor epoch model and the peer list. Health is now
    // an indexer-heartbeat surface — null fields mean the indexer has not
    // completed its first poll yet (or chain WSS has never connected).
    const obs = await db.getIndexerObservability();
    return c.json({
      ok: true,
      lastStatusFetchAt: obs?.lastStatusFetchAt ?? null,
      lastBlockInsertAt: obs?.lastBlockInsertAt ?? null,
      lastSubstrateEventAt: obs?.lastSubstrateEventAt ?? null,
      chainConnected: obs?.chainConnected ?? false,
    });
  });
}
