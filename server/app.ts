// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { registerBlocksRoute } from "./routes/blocks";
import { registerHealthRoute } from "./routes/health";
import { registerMiningAttemptsRoute } from "./routes/mining-attempts";
import { registerTelemetryRoute } from "./routes/telemetry";

interface StaticOptions {
  root?: string;
  path?: string;
}

type ServeStaticFactory = (options: StaticOptions) => MiddlewareHandler;

export interface CreateAppOptions {
  db: DatabaseAdapter;
  /**
   * Ordered fallback list for substrate RPC endpoints. Used to derive the
   * local operator's miner-REST base URL when no on-chain descriptor row
   * exists for `selfAddress` yet (the dashboard renders chain views from
   * day one; miner-REST surfaces depend on this fallback or descriptor
   * resolution).
   */
  validatorRpcUrls: string[];
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
  const { db, validatorRpcUrls, enableStatic = false, staticDir = "./dist", serveStatic } = options;
  const app = new Hono();

  registerTelemetryRoute(app, { db, validatorRpcUrls });
  registerBlocksRoute(app, db);
  registerMiningAttemptsRoute(app, validatorRpcUrls);
  registerHealthRoute(app, db);

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
