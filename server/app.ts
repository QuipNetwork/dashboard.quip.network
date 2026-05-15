// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { DatabaseAdapter } from "../api/db/adapter";
import type {
  ChainMinerRecord,
  NodeInfo,
  NodesSnapshot,
  TelemetryResponse,
} from "../src/types/telemetry";
import { getGeoIpEnricher, type GeoIpEnricher } from "./geo-ip";

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
  /** Test hook; production callers use the module-level singleton. */
  geoIp?: GeoIpEnricher;
}

const emptySnapshot: NodesSnapshot = {
  updatedAt: new Date(0).toISOString(),
  nodeCount: 0,
  activeCount: 0,
  nodes: {},
};

export function createApp(options: CreateAppOptions): Hono {
  const { db, enableStatic = false, staticDir = "./dist", serveStatic, geoIp } = options;
  const app = new Hono();

  app.get("/api/telemetry", async (c) => {
    const [
      blocks,
      nodes,
      selfAddress,
      indexer,
      chainHead,
      babeEpoch,
      babeAuthorities,
      rawChainMiners,
      recentDifficulty,
    ] = await Promise.all([
      db.getAllBlocks(),
      db.getNodes(),
      db.getSelfAddress(),
      db.getIndexerObservability(),
      db.getChainHead(),
      db.getCurrentBabeEpoch(),
      db.getActiveBabeAuthorities(),
      db.getChainMiners(),
      db.getRecentDifficulty(50),
    ]);
    const rawSnapshot = nodes ?? emptySnapshot;
    const enricher = geoIp ?? (await getGeoIpEnricher());
    const enrichedNodes: Record<string, NodeInfo> = enricher.enabled
      ? await enricher.enrichSnapshot(rawSnapshot.nodes)
      : rawSnapshot.nodes;

    // Chain miners → telemetry node join. quip-protocol-rs spec 101 does
    // not currently expose an ECDSA pubkey alongside the SS58 account_id,
    // so the join cannot fire — telemetryNodeAddress stays null. The
    // ChainMinerRecord type + UI plumbing are in place ahead of the chain
    // side adding that mapping (see plan rev 2 Task 0.8 follow-up).
    const chainMiners: ChainMinerRecord[] = rawChainMiners.map((m) => ({
      ...m,
      telemetryNodeAddress: null,
    }));

    const body: TelemetryResponse = {
      blocks,
      nodes: { ...rawSnapshot, nodes: enrichedNodes },
      selfAddress,
      indexer,
      serverTime: new Date().toISOString(),
      chainHead,
      babeEpoch,
      babeAuthorities,
      chainMiners,
      recentDifficulty,
    };
    return c.json(body);
  });

  app.get("/api/telemetry/index", async (c) => {
    const index = await db.getIndex();
    return c.json(index);
  });

  app.get("/api/telemetry/epochs/:epoch", async (c) => {
    // Epoch IDs are opaque 16-char hex hashes (e.g. e0a08eef1dfff726).
    // Only rough-validate the shape so an obvious path-injection attempt
    // produces 400 rather than a DB roundtrip with a bogus key.
    const epoch = c.req.param("epoch");
    if (!/^[0-9a-f]{8,64}$/i.test(epoch)) {
      return c.json({ error: "invalid epoch", detail: epoch }, 400);
    }
    const blocks = await db.getBlocksByEpoch(epoch);
    return c.json({ blocks });
  });

  app.get("/api/health", async (c) => {
    const [cursors, nodes] = await Promise.all([db.getCursors(), db.getNodes()]);
    return c.json({
      ok: true,
      tipCursor: cursors.tip,
      backfillCursor: cursors.backfill,
      lastSync: nodes?.updatedAt ?? null,
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
