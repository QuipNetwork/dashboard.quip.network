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
  await db.migrate();
  const app = createApp({ db, enableStatic: false });
  return async (req) => app.fetch(req);
}

function getFetcher(): Promise<Fetcher> {
  if (!fetcherPromise) {
    fetcherPromise = buildFetcher().catch((err) => {
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
