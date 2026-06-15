// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

import { getMigrations } from "../../migrations";

export interface MigrationStatusRow {
  name: string;
  applied: boolean;
  executedAt: Date | undefined;
}

function makeMigrator(db: Kysely<unknown>): Migrator {
  const provider: MigrationProvider = {
    async getMigrations(): Promise<Record<string, Migration>> {
      return getMigrations();
    },
  };
  return new Migrator({ db, provider });
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<{ applied: string[] }> {
  const { error, results } = await makeMigrator(db).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  const applied = (results ?? [])
    .filter((r) => r.status === "Success")
    .map((r) => r.migrationName);
  return { applied };
}

export async function migrationStatus(db: Kysely<unknown>): Promise<MigrationStatusRow[]> {
  const all = await makeMigrator(db).getMigrations();
  return all.map((m) => ({ name: m.name, applied: m.executedAt != null, executedAt: m.executedAt }));
}

export async function pendingMigrations(db: Kysely<unknown>): Promise<string[]> {
  const all = await makeMigrator(db).getMigrations();
  return all.filter((m) => m.executedAt == null).map((m) => m.name);
}
