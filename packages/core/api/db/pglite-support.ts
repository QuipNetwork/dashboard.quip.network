// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only support: an in-process Postgres (pglite, WASM) wired into Kysely so
// the suite runs against real Postgres semantics without an external service.
// Production never imports this — pglite is a devDependency.
//
// pglite init (~1.5s) dominates, so tests create ONE harness per file
// (beforeAll) and TRUNCATE between cases (beforeEach) rather than rebuilding.

import { PGlite } from "@electric-sql/pglite";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

import { KyselyAdapter } from "./kysely-adapter";
import type { DB } from "./schema-types";

class PgliteConnection implements DatabaseConnection {
  constructor(private readonly pg: PGlite) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const res = await this.pg.query<R>(compiled.sql, compiled.parameters as unknown[]);
    return {
      rows: res.rows as R[],
      numAffectedRows: res.affectedRows != null ? BigInt(res.affectedRows) : undefined,
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("streaming is not supported by the pglite dialect");
  }
}

class PgliteDriver implements Driver {
  private readonly connection: PgliteConnection;

  constructor(pg: PGlite) {
    this.connection = new PgliteConnection(pg);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("begin"));
  }
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("commit"));
  }
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("rollback"));
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export class PgliteDialect implements Dialect {
  constructor(private readonly pg: PGlite) {}

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }
  createDriver(): Driver {
    return new PgliteDriver(this.pg);
  }
  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

const DATA_TABLES = [
  "blocks",
  "miner_hardware",
  "meta",
  "chain_head",
  "babe_epochs",
  "babe_authorities",
  "chain_miners",
  "difficulty_history",
  "validator_authorship",
  "validator_authorship_blocks",
  "node_descriptors",
  "mining_submissions",
  "qblock_participation",
];

export interface PgliteHarness {
  adapter: KyselyAdapter;
  /** Raw Kysely handle for test-only seeding (e.g. legacy-table fixtures). */
  db: Kysely<DB>;
  /** Truncate all data tables (keeps the migrated schema + ledger). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A migrated, resettable in-memory Postgres adapter. One per test file.
 * `closeAdapterOnDisconnect: false` makes adapter.disconnect() a no-op (the
 * shared-adapter case where many tests disconnect but the pglite must survive);
 * use harness.close() to free it.
 */
export async function createPgliteHarness(
  opts: { closeAdapterOnDisconnect?: boolean } = {},
): Promise<PgliteHarness> {
  const pg = new PGlite();
  await pg.waitReady;
  const db = new Kysely<DB>({ dialect: new PgliteDialect(pg) });
  const onClose =
    opts.closeAdapterOnDisconnect === false ? async (): Promise<void> => {} : () => pg.close();
  const adapter = new KyselyAdapter({ databaseUrl: "pglite://memory" }, { db, onClose });
  await adapter.connect();
  await adapter.migrate();
  return {
    adapter,
    db,
    reset: async () => {
      await pg.query(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    },
    close: () => pg.close(),
  };
}

/** A virgin (un-migrated) pglite Kysely — for testing the migrator itself. */
export async function createPgliteKysely(): Promise<{
  kysely: Kysely<DB>;
  close: () => Promise<void>;
}> {
  const pg = new PGlite();
  await pg.waitReady;
  return { kysely: new Kysely<DB>({ dialect: new PgliteDialect(pg) }), close: () => pg.close() };
}
