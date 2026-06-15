// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter, DbConfig } from "./adapter";

export function getConfigFromEnv(): DbConfig {
  const rawAdapter = process.env.DB_ADAPTER;
  // DATABASE_URL without an explicit DB_ADAPTER is almost always a Postgres
  // deployment where the adapter env got dropped — falling through to sqlite
  // would silently write to a local file. Fail loud.
  if (!rawAdapter && process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is set but DB_ADAPTER is not. Set DB_ADAPTER=postgres explicitly to use the Postgres adapter, or unset DATABASE_URL to use SQLite.",
    );
  }
  const adapter = (rawAdapter ?? "sqlite") as DbConfig["adapter"];
  return {
    adapter,
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: process.env.SQLITE_PATH ?? "./data/telemetry.db",
  };
}

export async function createAdapter(config?: DbConfig): Promise<DatabaseAdapter> {
  const cfg = config ?? getConfigFromEnv();

  if (cfg.adapter !== "sqlite" && cfg.adapter !== "postgres") {
    throw new Error(`Unknown DB_ADAPTER: ${cfg.adapter}. Expected: sqlite, postgres`);
  }
  const { KyselyAdapter } = await import("./kysely-adapter");
  console.log(
    cfg.adapter === "postgres"
      ? "[db] using postgres"
      : `[db] using sqlite at ${cfg.sqlitePath ?? "./data/telemetry.db"}`,
  );
  return new KyselyAdapter(cfg);
}

export type { DatabaseAdapter, DbConfig } from "./adapter";
