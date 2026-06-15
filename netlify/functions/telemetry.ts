// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter, getConfigFromEnv } from "../../api/db/index";
import type { DatabaseAdapter } from "../../api/db/adapter";
import { createApp } from "../../server/app";

type Fetcher = (request: Request) => Promise<Response>;

let fetcherPromise: Promise<Fetcher> | null = null;

async function buildFetcher(): Promise<Fetcher> {
  const cfg = getConfigFromEnv();
  const db: DatabaseAdapter = await createAdapter(cfg);
  await db.connect();
  // No db.migrate() here: the serverless read path never migrates. Schema is
  // applied out-of-band by the dedicated `bun run migrate` command (run by the
  // deploy pipeline / docker entrypoint) against the same database.
  // Netlify deployments are chain-only (no embedded miner); the URL list
  // exists to satisfy the createApp contract but is never used because
  // the modal proxy endpoint is gated on db.getSelfAddress() being
  // populated — which only happens when a co-located indexer writes it.
  const validatorRpcUrls = (process.env.QUIP_VALIDATOR_RPC_URLS ?? "ws://quip-validator:9944")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s.length > 0);
  const app = createApp({ db, validatorRpcUrls, enableStatic: false });
  return async (req) => app.fetch(req);
}

function getFetcher(): Promise<Fetcher> {
  if (!fetcherPromise) {
    fetcherPromise = buildFetcher().catch((err) => {
      // Log with enough context to diagnose 500s from Netlify's function log.
      console.error(
        "[netlify] buildFetcher failed",
        {
          adapter: process.env.DB_ADAPTER ?? "sqlite",
          hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        },
        err,
      );
      fetcherPromise = null;
      throw err;
    });
  }
  return fetcherPromise;
}

export default async (req: Request): Promise<Response> => {
  const fetcher = await getFetcher();
  return fetcher(req);
};
