// SPDX-License-Identifier: AGPL-3.0-or-later

import { serveStatic } from "hono/bun";

import { createAdapter, getConfigFromEnv } from "../api/db/index";
import { createApp } from "./app";

// Default mirrors indexer/config.ts so a server started without
// QUIP_VALIDATOR_RPC_URLS still has a sensible fallback for the
// miner-REST URL derivation. Operators in non-docker-compose deployments
// override via env.
const DEFAULT_VALIDATOR_RPC_URLS = ["ws://quip-validator:9944"];

function parseValidatorRpcUrlsFromEnv(): string[] {
  const raw = process.env.QUIP_VALIDATOR_RPC_URLS;
  if (!raw) return DEFAULT_VALIDATOR_RPC_URLS;
  const urls = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s.length > 0);
  return urls.length > 0 ? urls : DEFAULT_VALIDATOR_RPC_URLS;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const staticDir = process.env.STATIC_DIR ?? "./dist";

  const cfg = getConfigFromEnv();
  const db = await createAdapter(cfg);
  await db.connect();
  await db.migrate();

  const validatorRpcUrls = parseValidatorRpcUrlsFromEnv();
  const app = createApp({
    db,
    validatorRpcUrls,
    enableStatic: true,
    staticDir,
    serveStatic,
  });

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
