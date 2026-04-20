// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter, getConfigFromEnv } from "../api/db/index";

async function main(): Promise<void> {
  const cfg = getConfigFromEnv();
  const db = await createAdapter(cfg);
  console.log(`[server] migrating adapter=${cfg.adapter}`);
  try {
    await db.connect();
    await db.migrate();
    console.log("[server] migration complete");
  } finally {
    await db.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[server] migration failed", err);
    process.exit(1);
  });
