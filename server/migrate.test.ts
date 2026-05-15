// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL_PATH = join(import.meta.dir, "../api/db/migrations/v5-substrate-fields.sql");

describe("v5 forward migration SQL", () => {
  const sql = readFileSync(SQL_PATH, "utf8");

  test("uses idempotent guards for all column adds", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS substrate_block_number");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS substrate_block_hash");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS substrate_parent_hash");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS extrinsics_root");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS state_root");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS finalized");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS is_canonical");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS chain_anchor");
  });

  test("creates all new v5 tables", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chain_head");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS babe_epochs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS babe_authorities");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS chain_miners");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS difficulty_history");
  });

  test("drops vestigial indexer_state", () => {
    expect(sql).toContain("DROP TABLE IF EXISTS indexer_state");
  });

  test("backfills is_canonical for stale_fork epochs", () => {
    expect(sql).toContain("UPDATE blocks SET is_canonical = FALSE");
    expect(sql).toContain("WHERE status = 'stale_fork'");
  });

  test("stamps schema_version=5 at the end", () => {
    expect(sql).toContain("schema_version");
    expect(sql).toMatch(/VALUES\s*\(\s*'schema_version'\s*,\s*'5'/);
  });

  test("wraps everything in a transaction", () => {
    expect(sql.trimStart()).toMatch(/^(--[^\n]*\n|\s)*BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;\s*$/);
  });
});
