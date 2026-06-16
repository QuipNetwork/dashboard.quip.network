// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter, DbConfig } from "./adapter";

export function getConfigFromEnv(): DbConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (Postgres connection string).");
  }
  return { databaseUrl };
}

export async function createAdapter(config?: DbConfig): Promise<DatabaseAdapter> {
  const cfg = config ?? getConfigFromEnv();
  const { KyselyAdapter } = await import("./kysely-adapter");
  console.log("[db] using postgres");
  return new KyselyAdapter(cfg);
}

export type { DatabaseAdapter, DbConfig } from "./adapter";
