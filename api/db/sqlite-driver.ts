// SPDX-License-Identifier: AGPL-3.0-or-later

export interface SqliteStatement<Row = unknown> {
  get(...params: unknown[]): Row | null;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  run(sql: string, params?: unknown[]): void;
  query<Row = unknown, _Params = unknown[]>(sql: string): SqliteStatement<Row>;
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void;
  close(): void;
}

export interface SqliteDatabaseConstructor {
  new (path: string, options?: { create?: boolean }): SqliteDatabase;
}

const runningOnBun = typeof process !== "undefined" && Boolean(process.versions?.bun);

interface NodeStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface NodeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}

function adaptStatement<Row>(stmt: NodeStatement): SqliteStatement<Row> {
  return {
    get: (...params) => (stmt.get(...params) ?? null) as Row | null,
    all: (...params) => stmt.all(...params) as Row[],
    run: (...params) => stmt.run(...params),
  };
}

function makeNodeDatabaseClass(
  DatabaseSync: new (path: string) => NodeDatabaseSync,
): SqliteDatabaseConstructor {
  return class NodeDatabase implements SqliteDatabase {
    private readonly raw: NodeDatabaseSync;

    constructor(path: string, _options?: { create?: boolean }) {
      this.raw = new DatabaseSync(path);
    }

    run(sql: string, params?: unknown[]): void {
      if (params === undefined) {
        this.raw.exec(sql);
        return;
      }
      this.raw.prepare(sql).run(...params);
    }

    query<Row = unknown>(sql: string): SqliteStatement<Row> {
      return adaptStatement<Row>(this.raw.prepare(sql));
    }

    prepare<Row = unknown>(sql: string): SqliteStatement<Row> {
      return adaptStatement<Row>(this.raw.prepare(sql));
    }

    transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
      return (...args: Args) => {
        this.raw.exec("BEGIN");
        try {
          fn(...args);
          this.raw.exec("COMMIT");
        } catch (err) {
          try {
            this.raw.exec("ROLLBACK");
          } catch {
            void 0;
          }
          throw err;
        }
      };
    }

    close(): void {
      this.raw.close();
    }
  };
}

async function resolveDatabase(): Promise<SqliteDatabaseConstructor> {
  if (runningOnBun) {
    const { Database: BunDatabase } = await import("bun:sqlite");
    return BunDatabase as unknown as SqliteDatabaseConstructor;
  }
  const { DatabaseSync } = await import("node:sqlite");
  return makeNodeDatabaseClass(DatabaseSync as unknown as new (path: string) => NodeDatabaseSync);
}

export const Database: SqliteDatabaseConstructor = await resolveDatabase();
export type Database = SqliteDatabase;
