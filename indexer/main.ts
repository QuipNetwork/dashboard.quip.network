// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "../api/db";

import { QuipClient } from "./client";
import { parseConfig } from "./config";
import { runLoop } from "./loop";
import { IndexerState } from "./state";

async function main(): Promise<void> {
  const config = parseConfig();
  console.log(
    `[indexer] starting node=${config.nodeUrl} poll=${config.pollIntervalSec}s` +
      ` nodesRefresh=${config.nodesRefreshSec}s once=${config.once}` +
      (config.backfillFromEpoch !== undefined ? ` backfillFrom=${config.backfillFromEpoch}` : ""),
  );

  const db = await createAdapter();
  await db.connect();
  await db.migrate();

  const client = new QuipClient({
    baseUrl: config.nodeUrl,
    token: config.token,
  });
  const state = new IndexerState(db);
  await state.load();

  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[indexer] received ${sig}, shutting down after current iteration`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await runLoop({ config, client, db, state }, () => stopping);
    // One last persist in case we stopped mid-iteration without saving.
    await state.save();
  } finally {
    await db.disconnect();
  }
  console.log("[indexer] stopped");
}

main().catch((e) => {
  console.error("[indexer] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
