// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter, getConfigFromEnv } from "@quip/core/db";
import type { DatabaseAdapter } from "@quip/core/db/adapter";

type Command = "up" | "status" | "dry-run";

function parseCommand(argv: string[]): Command {
  const arg = argv[2];
  if (!arg || arg === "up" || arg === "migrate") return "up";
  if (arg === "status") return "status";
  if (arg === "dry-run" || arg === "--dry-run" || arg === "plan") return "dry-run";
  throw new Error(`unknown migrate command: ${arg} (expected: up | status | dry-run)`);
}

async function runStatus(db: DatabaseAdapter): Promise<void> {
  const rows = await db.migrationStatus();
  if (rows.length === 0) {
    console.log("[migrate] no migrations defined");
    return;
  }
  for (const r of rows) {
    const mark = r.applied ? "applied" : "pending";
    const when = r.executedAt ? ` @ ${r.executedAt.toISOString()}` : "";
    console.log(`  [${mark}] ${r.name}${when}`);
  }
}

async function runDryRun(db: DatabaseAdapter): Promise<void> {
  const pending = await db.pendingMigrations();
  if (pending.length === 0) {
    console.log("[migrate] up to date — nothing to apply");
    return;
  }
  console.log(`[migrate] would apply ${pending.length} migration(s):`);
  for (const name of pending) console.log(`  + ${name}`);
}

async function runUp(db: DatabaseAdapter): Promise<void> {
  const before = await db.pendingMigrations();
  await db.migrate();
  if (before.length === 0) {
    console.log("[migrate] already up to date");
  } else {
    console.log(`[migrate] applied ${before.length} migration(s): ${before.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  const cfg = getConfigFromEnv();
  console.log(`[migrate] postgres command=${command}`);

  const db = await createAdapter(cfg);
  try {
    await db.connect();
    if (command === "status") await runStatus(db);
    else if (command === "dry-run") await runDryRun(db);
    else await runUp(db);
  } finally {
    await db.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate] failed", err);
    process.exit(1);
  });
