// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { DatabaseAdapter } from "../api/db/adapter";
import type { TelemetryResponse, ValidatorAuthorshipRecord } from "../src/types/telemetry";

// "Online" threshold for the Active Validators table. A validator counts
// as online when its most recent authored head is within this window of
// the request wall-clock. 3 minutes is roughly 30x the 6s block time on
// quip-protocol-rs spec 101 — short enough to catch operator outages,
// long enough that BABE slot skips don't briefly flap a healthy node.
const VALIDATOR_ONLINE_WINDOW_MS = 3 * 60 * 1000;

interface StaticOptions {
  root?: string;
  path?: string;
}

type ServeStaticFactory = (options: StaticOptions) => MiddlewareHandler;

export interface CreateAppOptions {
  db: DatabaseAdapter;
  enableStatic?: boolean;
  staticDir?: string;
  /**
   * Factory producing a Hono static-file middleware given (root, path?).
   * Injected by `server/main.ts` so this module never imports `hono/bun` —
   * the Netlify runtime (Node) cannot load Bun-only adapters at module scope.
   */
  serveStatic?: ServeStaticFactory;
}

export function createApp(options: CreateAppOptions): Hono {
  const { db, enableStatic = false, staticDir = "./dist", serveStatic } = options;
  const app = new Hono();

  app.get("/api/telemetry", async (c) => {
    const [
      blocks,
      selfAddress,
      indexer,
      chainHead,
      babeEpoch,
      babeAuthorities,
      chainMiners,
      recentDifficulty,
      allHardware,
      authorship,
    ] = await Promise.all([
      // Page-1 default; the UI can request later pages once pagination lands.
      db.getRecentBlocks(500, 0),
      db.getSelfAddress(),
      db.getIndexerObservability(),
      db.getChainHead(),
      db.getCurrentBabeEpoch(),
      db.getActiveBabeAuthorities(),
      db.getChainMiners(),
      db.getRecentDifficulty(50),
      db.getAllMinerHardware(),
      db.getValidatorAuthorship(),
    ]);

    // Join chain_miners → miner_hardware on accountId so the UI can render
    // a per-row "telemetry node" link without a second fetch. Today only
    // self has a miner_hardware row (source='self'); future peer-query and
    // chain-surface upgrades populate other entries.
    const hardwareByAccount = new Map(allHardware.map((h) => [h.accountId, h]));
    const enrichedMiners = chainMiners.map((m) => ({
      ...m,
      telemetryNodeAddress: hardwareByAccount.get(m.accountId)?.nodeId ?? null,
      hardware: hardwareByAccount.get(m.accountId) ?? null,
    }));

    // Join the active BABE authority set → per-validator authorship stats.
    // Validators that haven't authored a head the indexer has seen surface
    // with 0 counters and `online: false`; the row still appears in the
    // table so operators see their full authority set, not just the busy
    // ones.
    const authorshipByAccount = new Map(authorship.map((a) => [a.accountId, a]));
    const nowMs = Date.now();
    const validators: ValidatorAuthorshipRecord[] = babeAuthorities.map((a) => {
      const stats = authorshipByAccount.get(a.accountId);
      const lastAuthoredAt = stats?.lastAuthoredAt ?? null;
      const ageMs = lastAuthoredAt ? nowMs - Date.parse(lastAuthoredAt) : Infinity;
      return {
        accountId: a.accountId,
        blocksAuthored: stats?.blocksAuthored ?? 0,
        blocksAuthoredWithPow: stats?.blocksAuthoredWithPow ?? 0,
        lastAuthoredBlock: stats?.lastAuthoredBlock ?? null,
        lastAuthoredAt,
        online: ageMs < VALIDATOR_ONLINE_WINDOW_MS,
      };
    });

    return c.json({
      blocks,
      selfAddress,
      indexer,
      serverTime: new Date().toISOString(),
      chainHead,
      babeEpoch,
      babeAuthorities,
      chainMiners: enrichedMiners,
      recentDifficulty,
      validators,
    } satisfies TelemetryResponse);
  });

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

  if (enableStatic) {
    if (!serveStatic) {
      throw new Error(
        "[server] enableStatic=true requires a serveStatic factory (see server/main.ts)",
      );
    }
    app.use("/*", serveStatic({ root: staticDir }));
    app.get("/*", serveStatic({ root: staticDir, path: "index.html" }));
  }

  return app;
}
