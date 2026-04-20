// SPDX-License-Identifier: AGPL-3.0-or-later

import { serveStatic } from "hono/bun";

import { createAdapter, getConfigFromEnv } from "../api/db/index";
import { createApp } from "./app";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const staticDir = process.env.STATIC_DIR ?? "./dist";

  const cfg = getConfigFromEnv();
  const db = await createAdapter(cfg);
  await db.connect();
  await db.migrate();

  const app = createApp({ db, enableStatic: true, staticDir, serveStatic });

  const server = Bun.serve({ port, fetch: app.fetch });

  const shutdown = async (signal: string) => {
    console.log(`[server] received ${signal}, shutting down`);
    try {
      await server.stop();
      await db.disconnect();
    } catch (err) {
      console.error("[server] shutdown error", err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  console.log(`[server] listening on http://localhost:${server.port}`);
}

main().catch((err) => {
  console.error("[server] fatal", err);
  process.exit(1);
});
