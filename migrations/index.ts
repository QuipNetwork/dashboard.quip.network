// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from "kysely/migration";

import type { MigrationDialect } from "../api/db/migrator";
import * as initial from "./0001_initial";

// Static registry of forward-only migrations, newest last. Each migration is
// dialect-aware (column types differ between sqlite and postgres), so the
// dialect is threaded in here rather than discovered at runtime.
export function getMigrations(dialect: MigrationDialect): Record<string, Migration> {
  return {
    "0001_initial": { up: (db) => initial.up(db, dialect) },
  };
}
