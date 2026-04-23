// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { PostgresAdapter } from "./postgres";

// Postgres integration tests require a reachable database. Gate behind
// TEST_POSTGRES_URL so CI and dev environments without a local postgres
// don't spuriously fail. The URL should point at a disposable database —
// the migrate step drops all owned tables when schema_version drifts.
const TEST_URL = process.env.TEST_POSTGRES_URL;

async function freshPostgres(): Promise<PostgresAdapter> {
  // Force a clean slate: run migrate() once to ensure `meta` exists, then
  // write a sentinel schema_version so the *second* migrate() treats it as
  // drift and drops all owned tables. Only works against a local postgres
  // (isLocalDeployment() must return true) — TEST_POSTGRES_URL should
  // therefore point at a disposable database on localhost/docker.
  const db = new PostgresAdapter({ adapter: "postgres", databaseUrl: TEST_URL });
  await db.connect();
  await db.migrate();
  await db.setMetaRaw("schema_version", "-1");
  await db.migrate();
  return db;
}

describe.skipIf(!TEST_URL)("PostgresAdapter getCursors / saveCursors", () => {
  it("returns fresh defaults when no cursors have been saved", async () => {
    const db = await freshPostgres();
    const c = await db.getCursors();
    expect(c.tip).toEqual({ epoch: null, blockIndex: 0 });
    expect(c.backfill).toEqual({ epoch: null, blockIndex: 0 });
    await db.disconnect();
  });

  it("round-trips tip + backfill + etags", async () => {
    const db = await freshPostgres();
    await db.saveCursors(
      { epoch: "abc", blockIndex: 42 },
      { epoch: "def", blockIndex: 17 },
      { nodes: "etag-1" },
    );
    const c = await db.getCursors();
    expect(c.tip).toEqual({ epoch: "abc", blockIndex: 42 });
    expect(c.backfill).toEqual({ epoch: "def", blockIndex: 17 });
    expect((await db.getEtags()).nodes).toBe("etag-1");
    await db.disconnect();
  });

  it("treats a corrupt indexer_cursors blob as 'no cursors'", async () => {
    const db = await freshPostgres();
    // Write garbage under the key the adapter reads from.
    await db.setMetaRaw("indexer_cursors", "{not json");
    const c = await db.getCursors();
    expect(c.tip).toEqual({ epoch: null, blockIndex: 0 });
    expect(c.backfill).toEqual({ epoch: null, blockIndex: 0 });
    await db.disconnect();
  });
});
