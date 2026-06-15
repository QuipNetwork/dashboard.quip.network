// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

import type { SqliteDatabase } from "./sqlite-driver";

// A Kysely dialect over the project's unified synchronous SqliteDatabase
// (bun:sqlite or node:sqlite via sqlite-driver), so migrations run on either
// runtime without pulling in better-sqlite3.
class SqliteDriverConnection implements DatabaseConnection {
  constructor(private readonly db: SqliteDatabase) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const params = compiled.parameters as unknown[];
    const returnsRows =
      compiled.query.kind === "SelectQueryNode" || /\breturning\b/i.test(compiled.sql);
    if (returnsRows) {
      const rows = this.db.query<R>(compiled.sql).all(...params);
      return { rows };
    }
    const res = this.db.prepare(compiled.sql).run(...params) as
      | { changes?: number | bigint; lastInsertRowid?: number | bigint }
      | undefined;
    return {
      rows: [],
      numAffectedRows: res?.changes != null ? BigInt(res.changes) : undefined,
      insertId: res?.lastInsertRowid != null ? BigInt(res.lastInsertRowid) : undefined,
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("streaming is not supported by the sqlite driver dialect");
  }
}

class SqliteDriverKyselyDriver implements Driver {
  private readonly connection: SqliteDriverConnection;

  constructor(db: SqliteDatabase) {
    this.connection = new SqliteDriverConnection(db);
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

export class SqliteDriverDialect implements Dialect {
  constructor(private readonly db: SqliteDatabase) {}

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter();
  }
  createDriver(): Driver {
    return new SqliteDriverKyselyDriver(this.db);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
