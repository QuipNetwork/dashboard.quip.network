// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from "kysely/migration";

import * as initial from "./0001_initial";
import * as telemetrySortIndexes from "./0002_telemetry_sort_indexes";

// Static registry of forward-only migrations, newest last.
export function getMigrations(): Record<string, Migration> {
  return {
    "0001_initial": { up: (db) => initial.up(db) },
    "0002_telemetry_sort_indexes": { up: (db) => telemetrySortIndexes.up(db) },
  };
}
