// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely } from "kysely";

import { SqliteDriverDialect } from "./kysely-sqlite-dialect";
import { Database, type Database as Db } from "./sqlite-driver";

let dir: string;
interface TestDb {
  widget: { id: number; name: string };
  again: { id: number };
}

let raw: Db;
let k: Kysely<TestDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kysely-sqlite-"));
  raw = new Database(join(dir, "t.db"), { create: true });
  k = new Kysely({ dialect: new SqliteDriverDialect(raw) });
});

afterEach(async () => {
  await k.destroy();
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteDriverDialect", () => {
  it("creates a table, inserts, and selects through Kysely", async () => {
    await k.schema
      .createTable("widget")
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .execute();

    await k.insertInto("widget").values({ id: 1, name: "alpha" }).execute();
    await k.insertInto("widget").values({ id: 2, name: "beta" }).execute();

    const rows = await k.selectFrom("widget").selectAll().orderBy("id").execute();
    expect(rows).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
  });

  it("ifNotExists makes re-create a no-op (forward-only baseline adoption)", async () => {
    const create = () =>
      k.schema
        .createTable("again")
        .ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey())
        .execute();
    await create();
    await create();
    const rows = await k.selectFrom("again").selectAll().execute();
    expect(rows).toEqual([]);
  });
});
