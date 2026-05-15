// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { createAdapter, getConfigFromEnv } from "../api/db/index";
import { isLocalDeployment } from "../api/db/adapter";

const V5_SQL_PATH = join(import.meta.dir, "../api/db/migrations/v5-substrate-fields.sql");

/**
 * For remote Postgres deployments (Supabase) the adapter's `drop on drift`
 * path is intentionally disabled — production data must never be wiped by
 * a restart. This script applies the v4 → v5 forward migration SQL once,
 * idempotently, so an out-of-band CLI run is the only thing that mutates
 * the production schema.
 *
 * Local deployments (SQLite, docker-compose Postgres) skip this path —
 * the adapter's drift-drop handles them and re-runs SCHEMA_STATEMENTS.
 */
async function applyForwardMigrationIfRemotePostgres(): Promise<void> {
  const cfg = getConfigFromEnv();
  if (cfg.adapter !== "postgres") return;
  if (isLocalDeployment(cfg)) return;
  if (!cfg.databaseUrl) return;

  const sql = postgres(cfg.databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = 'schema_version'
    `.catch(() => [] as { value: string | null }[]);
    const stored = rows[0]?.value !== undefined && rows[0].value !== null ? Number(rows[0].value) : null;
    if (stored === 5) {
      console.log("[server] remote postgres already at schema_version=5, skipping forward SQL");
      return;
    }
    console.log(`[server] remote postgres at stored=${stored ?? "none"}; applying v5 forward migration`);
    const ddl = readFileSync(V5_SQL_PATH, "utf8");
    await sql.unsafe(ddl);
    console.log("[server] v5 forward migration applied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const cfg = getConfigFromEnv();
  console.log(`[server] migrating adapter=${cfg.adapter}`);

  await applyForwardMigrationIfRemotePostgres();

  const db = await createAdapter(cfg);
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
