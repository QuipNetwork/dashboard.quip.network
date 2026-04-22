// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { DatabaseAdapter } from "../api/db/adapter";
import type { NodeInfo, NodesSnapshot, TelemetryResponse } from "../src/types/telemetry";
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
    const [blocks, nodes, selfAddress, indexer] = await Promise.all([
      db.getAllBlocks(),
      db.getNodes(),
      db.getSelfAddress(),
      db.getIndexerObservability(),
    ]);
    const rawSnapshot = nodes ?? emptySnapshot;
    const enricher = geoIp ?? (await getGeoIpEnricher());
    const enrichedNodes: Record<string, NodeInfo> = enricher.enabled
      ? await enricher.enrichSnapshot(rawSnapshot.nodes)
      : rawSnapshot.nodes;
    const body: TelemetryResponse = {
      blocks,
      nodes: { ...rawSnapshot, nodes: enrichedNodes },
      selfAddress,
      indexer,
    };
    return c.json(body);
  });

  app.get("/api/telemetry/index", async (c) => {
    const index = await db.getIndex();
    return c.json(index);
  });

  app.get("/api/telemetry/epochs/:epoch", async (c) => {
    const raw = c.req.param("epoch");
    const epoch = Number(raw);
    if (!Number.isFinite(epoch) || !Number.isInteger(epoch)) {
      return c.json({ error: "invalid epoch", detail: raw }, 400);
    }
    const blocks = await db.getBlocksByEpoch(epoch);
    return c.json({ blocks });
  });

  app.get("/api/health", async (c) => {
    const [cursor, nodes] = await Promise.all([db.getCursor(), db.getNodes()]);
    return c.json({
      ok: true,
      cursor,
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
