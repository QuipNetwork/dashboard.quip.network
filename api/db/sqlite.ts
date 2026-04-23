// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  BlockRecord,
  EpochId,
  EpochStatus,
  IndexerCursor,
  IndexerObservability,
  NodesSnapshot,
  TelemetryIndex,
} from "../../src/types/telemetry";
import {
  OWNED_TABLES,
  SCHEMA_VERSION,
  parseIndexerObservability,
  type DatabaseAdapter,
  type DbConfig,
  type EpochStatusEntry,
} from "./adapter";

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS blocks (
     epoch               TEXT NOT NULL,
     block_index         INTEGER NOT NULL,
     block_hash          TEXT NOT NULL,
     timestamp           INTEGER NOT NULL,
     previous_hash       TEXT NOT NULL,
     miner_id            TEXT NOT NULL,
     miner_category      TEXT NOT NULL,
     ecdsa_public_key    TEXT NOT NULL,
     energy              REAL NOT NULL,
     diversity           REAL NOT NULL,
     num_valid_solutions INTEGER NOT NULL,
     mining_time         REAL NOT NULL,
     nonce               TEXT NOT NULL,
     num_nodes           INTEGER NOT NULL,
     num_edges           INTEGER NOT NULL,
     difficulty_energy   REAL NOT NULL,
     min_diversity       REAL NOT NULL,
     min_solutions       INTEGER NOT NULL,
     PRIMARY KEY (epoch, block_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id)`,
  `CREATE TABLE IF NOT EXISTS nodes_snapshot (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     payload    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS indexer_state (
     id                 INTEGER PRIMARY KEY CHECK (id = 1),
     cursor_epoch       TEXT,
     cursor_block       INTEGER NOT NULL DEFAULT 0,
     last_nodes_etag    TEXT,
     updated_at         TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS epoch_status (
     epoch   TEXT PRIMARY KEY,
     status  TEXT NOT NULL CHECK (status IN ('live','stale_fork'))
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
];

const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";

interface BlockRow {
  epoch: string;
  block_index: number;
  block_hash: string;
  timestamp: number;
  previous_hash: string;
  miner_id: string;
  miner_category: string;
  ecdsa_public_key: string;
  energy: number;
  diversity: number;
  num_valid_solutions: number;
  mining_time: number;
  nonce: string;
  num_nodes: number;
  num_edges: number;
  difficulty_energy: number;
  min_diversity: number;
  min_solutions: number;
}

interface EpochIndexRow {
  epoch: string;
  block_count: number;
  status: string | null;
  first_block_timestamp: number | null;
}

interface StateRow {
  cursor_epoch: string | null;
  cursor_block: number;
  last_nodes_etag: string | null;
}

function rowToBlock(r: BlockRow): BlockRecord {
  return {
    epoch: r.epoch,
    blockIndex: r.block_index,
    blockHash: r.block_hash,
    timestamp: r.timestamp,
    previousHash: r.previous_hash,
    minerId: r.miner_id,
    minerCategory: r.miner_category as BlockRecord["minerCategory"],
    ecdsaPublicKey: r.ecdsa_public_key,
    energy: r.energy,
    diversity: r.diversity,
    numValidSolutions: r.num_valid_solutions,
    miningTime: r.mining_time,
    nonce: r.nonce,
    numNodes: r.num_nodes,
    numEdges: r.num_edges,
    difficultyEnergy: r.difficulty_energy,
    minDiversity: r.min_diversity,
    minSolutions: r.min_solutions,
  };
}

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(config: DbConfig) {
    this.dbPath = config.sqlitePath ?? "./data/telemetry.db";
  }

  async connect(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    // Avoid SQLITE_BUSY when indexer writes contend with server reads.
    this.db.run("PRAGMA busy_timeout = 5000");
  }

  async disconnect(): Promise<void> {
    const db = this.db;
    if (db) {
      // Keep the .wal file from growing unbounded between restarts.
      try {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (e) {
        console.warn("[db] wal_checkpoint failed on close:", e);
      }
      db.close();
    }
    this.db = null;
  }

  async migrate(): Promise<void> {
    const db = this.requireDb();
    // meta must exist before we can read/write schema_version. Created as a
    // standalone CREATE IF NOT EXISTS so the drift check can run before we
    // apply the rest of SCHEMA_STATEMENTS.
    db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const row = db
      .query<{ value: string | null }, []>(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get();
    const stored = row?.value !== undefined && row.value !== null ? Number(row.value) : null;

    if (stored !== SCHEMA_VERSION) {
      // sqlite is always a local deployment — we own the file. Drop on drift.
      console.warn(
        `[db] SCHEMA DRIFT detected (stored=${stored ?? "none"}, code=${SCHEMA_VERSION}); dropping all owned tables`,
      );
      for (const table of OWNED_TABLES) db.run(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', $v)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run({ $v: String(SCHEMA_VERSION) });
  }

  async insertBlock(b: BlockRecord): Promise<boolean> {
    const result = this.requireDb()
      .prepare(
        `INSERT OR IGNORE INTO blocks (
           epoch, block_index, block_hash, timestamp, previous_hash,
           miner_id, miner_category, ecdsa_public_key,
           energy, diversity, num_valid_solutions, mining_time,
           nonce, num_nodes, num_edges,
           difficulty_energy, min_diversity, min_solutions
         ) VALUES (
           $epoch, $blockIndex, $blockHash, $timestamp, $previousHash,
           $minerId, $minerCategory, $ecdsaPublicKey,
           $energy, $diversity, $numValidSolutions, $miningTime,
           $nonce, $numNodes, $numEdges,
           $difficultyEnergy, $minDiversity, $minSolutions
         )`,
      )
      .run({
        $epoch: b.epoch,
        $blockIndex: b.blockIndex,
        $blockHash: b.blockHash,
        $timestamp: b.timestamp,
        $previousHash: b.previousHash,
        $minerId: b.minerId,
        $minerCategory: b.minerCategory,
        $ecdsaPublicKey: b.ecdsaPublicKey,
        $energy: b.energy,
        $diversity: b.diversity,
        $numValidSolutions: b.numValidSolutions,
        $miningTime: b.miningTime,
        $nonce: b.nonce,
        $numNodes: b.numNodes,
        $numEdges: b.numEdges,
        $difficultyEnergy: b.difficultyEnergy,
        $minDiversity: b.minDiversity,
        $minSolutions: b.minSolutions,
      });
    return result.changes > 0;
  }

  async getAllBlocks(): Promise<BlockRecord[]> {
    const rows = this.requireDb()
      .query("SELECT * FROM blocks ORDER BY timestamp, block_index")
      .all() as BlockRow[];
    return rows.map(rowToBlock);
  }

  async getBlocksByEpoch(epoch: EpochId): Promise<BlockRecord[]> {
    const rows = this.requireDb()
      .query("SELECT * FROM blocks WHERE epoch = ? ORDER BY block_index")
      .all(epoch) as BlockRow[];
    return rows.map(rowToBlock);
  }

  async getIndex(): Promise<TelemetryIndex> {
    const db = this.requireDb();
    // LEFT JOIN epoch_status so rows survive if the indexer has blocks for
    // an epoch but hasn't yet upserted its status (race between /epochs and
    // /block writes). Status defaults to stale_fork in that case so the UI
    // never spuriously badges an epoch as "live" before confirmation.
    // firstBlockTimestamp derives from block_index=1; NULL if that block
    // wasn't indexed — the UI handles the missing case.
    const rows = db
      .query(
        `SELECT b.epoch AS epoch,
                COUNT(*) AS block_count,
                COALESCE(es.status, 'stale_fork') AS status,
                MAX(CASE WHEN b.block_index = 1 THEN b.timestamp END) AS first_block_timestamp
         FROM blocks b
         LEFT JOIN epoch_status es ON es.epoch = b.epoch
         GROUP BY b.epoch
         ORDER BY first_block_timestamp IS NULL, first_block_timestamp DESC, b.epoch`,
      )
      .all() as EpochIndexRow[];
    const lastUpdated = (await this.getNodes())?.updatedAt ?? new Date().toISOString();
    return {
      epochs: rows.map((r) => ({
        epoch: r.epoch,
        blockCount: r.block_count,
        status: (r.status === "live" ? "live" : "stale_fork") as EpochStatus,
        firstBlockTimestamp: r.first_block_timestamp,
      })),
      lastUpdated,
    };
  }

  async replaceEpochStatus(entries: EpochStatusEntry[]): Promise<void> {
    const db = this.requireDb();
    // One transaction: a partial write where a chain transition is only
    // half-applied would momentarily show the wrong "live" epoch in the UI.
    const tx = db.transaction((es: EpochStatusEntry[]) => {
      db.run("DELETE FROM epoch_status");
      const ins = db.prepare(`INSERT INTO epoch_status (epoch, status) VALUES ($epoch, $status)`);
      for (const e of es) ins.run({ $epoch: e.epoch, $status: e.status });
    });
    tx(entries);
  }

  async upsertNodes(snapshot: NodesSnapshot): Promise<number> {
    this.requireDb()
      .prepare(
        `INSERT INTO nodes_snapshot (id, payload) VALUES (1, $p)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run({ $p: JSON.stringify(snapshot) });
    return Object.keys(snapshot.nodes).length;
  }

  async getNodes(): Promise<NodesSnapshot | null> {
    const row = this.requireDb()
      .query<{ payload: string }, []>("SELECT payload FROM nodes_snapshot WHERE id = 1")
      .get();
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as NodesSnapshot;
    } catch (e) {
      // Surface corruption loudly instead of silently returning an empty
      // snapshot (which would make /api/health lie about sync state).
      const head = row.payload.slice(0, 80);
      throw new Error(
        `[db] corrupt nodes_snapshot payload (${row.payload.length} bytes, starts with ${JSON.stringify(head)}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async getCursor(): Promise<IndexerCursor> {
    const row = this.requireDb()
      .query<
        StateRow,
        []
      >("SELECT cursor_epoch, cursor_block, last_nodes_etag FROM indexer_state WHERE id = 1")
      .get();
    return {
      epoch: row?.cursor_epoch ?? null,
      blockIndex: row?.cursor_block ?? 0,
    };
  }

  async saveCursor(cursor: IndexerCursor, etags: { nodes?: string | null }): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO indexer_state (
           id, cursor_epoch, cursor_block, last_nodes_etag, updated_at
         ) VALUES (1, $epoch, $block, $nodes, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           cursor_epoch = excluded.cursor_epoch,
           cursor_block = excluded.cursor_block,
           last_nodes_etag = COALESCE(excluded.last_nodes_etag, indexer_state.last_nodes_etag),
           updated_at = excluded.updated_at`,
      )
      .run({
        $epoch: cursor.epoch,
        $block: cursor.blockIndex,
        $nodes: etags.nodes ?? null,
        $updatedAt: new Date().toISOString(),
      });
  }

  async getEtags(): Promise<{ nodes: string | null }> {
    const row = this.requireDb()
      .query<
        StateRow,
        []
      >("SELECT cursor_epoch, cursor_block, last_nodes_etag FROM indexer_state WHERE id = 1")
      .get();
    return {
      nodes: row?.last_nodes_etag ?? null,
    };
  }

  async getSelfAddress(): Promise<string | null> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(SELF_ADDRESS_KEY);
    return row?.value ?? null;
  }

  async setSelfAddress(address: string | null): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: SELF_ADDRESS_KEY, $v: address });
  }

  async getIndexerObservability(): Promise<IndexerObservability | null> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(INDEXER_OBSERVABILITY_KEY);
    if (!row?.value) return null;
    return parseIndexerObservability(row.value, "sqlite");
  }

  async setIndexerObservability(obs: IndexerObservability): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: INDEXER_OBSERVABILITY_KEY, $v: JSON.stringify(obs) });
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("SQLiteAdapter not connected. Call connect() first.");
    }
    return this.db;
  }
}
