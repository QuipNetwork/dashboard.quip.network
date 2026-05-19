// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres, { type Sql } from "postgres";

import { createAdapter, getConfigFromEnv } from "../api/db/index";
import { isLocalDeployment, type DbConfig } from "../api/db/adapter";

const V5_SQL_PATH = join(import.meta.dir, "../api/db/migrations/v5-substrate-fields.sql");
const V6_SQL_PATH = join(import.meta.dir, "../api/db/migrations/v6-drop-epoch-abstraction.sql");

/**
 * Read the recorded `schema_version` from `meta`. Returns null when the row
 * (or the table itself) doesn't exist — a brand-new database that has never
 * been migrated.
 */
async function readSchemaVersion(sql: Sql): Promise<number | null> {
  const rows = await sql<{ value: string | null }[]>`
    SELECT value FROM meta WHERE key = 'schema_version'
  `.catch(() => [] as { value: string | null }[]);
  const raw = rows[0]?.value;
  if (raw === undefined || raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Apply a forward-migration SQL file. The file itself owns BEGIN/COMMIT, so
 * postgres-js's `sql.unsafe(...)` runs it as a single multi-statement query
 * that commits or rolls back as one unit.
 */
async function applyMigrationFile(sql: Sql, path: string, label: string): Promise<void> {
  const ddl = readFileSync(path, "utf8");
  await sql.unsafe(ddl);
  console.log(`[server] ${label} forward migration applied`);
}

/**
 * For remote Postgres deployments (Supabase) the adapter's `drop on drift`
 * path is intentionally disabled — production data must never be wiped by
 * a restart. This script applies forward-migration SQL files for any stored
 * versions strictly older than the current code version, idempotently and in
 * order. A single run can chain v4 → v5 → v6 if needed.
 *
 * Local deployments (SQLite, docker-compose Postgres) skip this path —
 * the adapter's drift-drop handles them and re-runs SCHEMA_STATEMENTS.
 */
async function applyForwardMigrationIfRemotePostgres(cfg: DbConfig): Promise<void> {
  if (cfg.adapter !== "postgres") return;
  if (isLocalDeployment(cfg)) return;
  if (!cfg.databaseUrl) return;

  const sql = postgres(cfg.databaseUrl, { max: 1 });
  try {
    // v4 → v5: idempotent in its own right. The script's INSERT … ON CONFLICT
    // bumps `schema_version` to 5, so a stored=5 input is a no-op after we
    // bail out below; a stored=null (fresh DB) input runs the full v5 ladder.
    let stored = await readSchemaVersion(sql);
    if (stored === null || stored < 5) {
      console.log(
        `[server] remote postgres at stored=${stored ?? "none"}; applying v5 forward migration`,
      );
      await applyMigrationFile(sql, V5_SQL_PATH, "v5");
      stored = await readSchemaVersion(sql);
    } else {
      console.log(`[server] remote postgres already at schema_version=${stored}, skipping v5`);
    }

    // v5 → v6: drops the epoch abstraction, promotes block_hash to PK, adds
    // miner_hardware. The script's final UPDATE bumps schema_version to 6.
    if (stored === 5) {
      console.log("[server] remote postgres at stored=5; applying v5 -> v6 forward migration");
      await applyMigrationFile(sql, V6_SQL_PATH, "v5 -> v6");
    } else if (stored !== null && stored >= 6) {
      console.log(`[server] remote postgres already at schema_version=${stored}, skipping v6`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const cfg = getConfigFromEnv();
  console.log(`[server] migrating adapter=${cfg.adapter}`);

  await applyForwardMigrationIfRemotePostgres(cfg);

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
