// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-shot maintenance command: recover the true `first_block_timestamp`
// ("firstSeen") for every node descriptor. Use after a from-scratch rebuild of
// `node_descriptors`, where the live head-snapshot path seeds firstSeen from
// each account's latest `updated_at` rather than its first registration.
//
// Requires an ARCHIVE node (it reads historical registry state) and a DB whose
// schema is already migrated. Reuses the indexer's config (validator URL list,
// RPC timeout) and connects to the first URL. Safe to re-run — it only ever
// lowers firstSeen toward the truth.
//
//   bun run apps/indexer/reconstruct-firstseen.ts
//   QUIP_VALIDATOR_RPC_URLS=wss://archive:443 bun run apps/indexer/reconstruct-firstseen.ts

import { createAdapter } from "@quip/core/db";

import { parseConfig } from "./core/config";
import { PolkadotSubstrateClient } from "./clients/substrate-client";
import { reconstructFirstSeen } from "./descriptor/reconstruct";

async function main(): Promise<void> {
  const config = parseConfig();
  const url = config.validatorRpcUrls[0]!;
  console.log(`[indexer] firstSeen reconstruction against ${url} (archive node required)`);

  const db = await createAdapter();
  await db.connect();
  const client = new PolkadotSubstrateClient(url, config.substrateRpcTimeoutMs);
  await client.connect();

  try {
    const summary = await reconstructFirstSeen({
      source: client,
      store: db,
      log: (msg) => console.log(msg),
    });
    console.log(
      `[indexer] firstSeen reconstruction done: ` +
        `${summary.accountsProcessed} corrected, ${summary.accountsSkipped} skipped, ` +
        `${summary.presenceReads} presence reads`,
    );
  } finally {
    await client.disconnect();
    await db.disconnect();
  }
}

main().catch((err) => {
  console.error("[indexer] reconstruct-firstseen fatal", err);
  process.exit(1);
});
