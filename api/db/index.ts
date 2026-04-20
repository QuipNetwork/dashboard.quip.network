// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter, DbConfig } from "./adapter";

export function getConfigFromEnv(): DbConfig {
  const adapter = (process.env.DB_ADAPTER ?? "sqlite") as DbConfig["adapter"];
  return {
    adapter,
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: process.env.SQLITE_PATH ?? "./data/telemetry.db",
  };
}

export async function createAdapter(config?: DbConfig): Promise<DatabaseAdapter> {
  const cfg = config ?? getConfigFromEnv();

  switch (cfg.adapter) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./sqlite");
      return new SQLiteAdapter(cfg);
    }
    case "postgres": {
      const { PostgresAdapter } = await import("./postgres");
      return new PostgresAdapter(cfg);
    }
    default:
      throw new Error(`Unknown DB_ADAPTER: ${cfg.adapter}. Expected: sqlite, postgres`);
  }
}

export type { DatabaseAdapter, DbConfig } from "./adapter";
