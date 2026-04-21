// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  BlockRecord,
  IndexerCursor,
  NodesSnapshot,
  TelemetryIndex,
} from "../../src/types/telemetry";
import type { DatabaseAdapter, DbConfig } from "./adapter";

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS blocks (
     epoch               INTEGER NOT NULL,
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
     cursor_epoch       INTEGER,
     cursor_block       INTEGER NOT NULL DEFAULT 0,
     last_nodes_etag    TEXT,
     updated_at         TEXT NOT NULL
   )`,
];

interface BlockRow {
  epoch: number;
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

interface EpochCountRow {
  epoch: number;
  block_count: number;
}

interface StateRow {
  cursor_epoch: number | null;
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
    for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
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

  async getBlocksByEpoch(epoch: number): Promise<BlockRecord[]> {
    const rows = this.requireDb()
      .query("SELECT * FROM blocks WHERE epoch = ? ORDER BY block_index")
      .all(epoch) as BlockRow[];
    return rows.map(rowToBlock);
  }

  async getIndex(): Promise<TelemetryIndex> {
    const db = this.requireDb();
    const rows = db
      .query("SELECT epoch, COUNT(*) AS block_count FROM blocks GROUP BY epoch ORDER BY epoch")
      .all() as EpochCountRow[];
    const lastUpdated = (await this.getNodes())?.updatedAt ?? new Date().toISOString();
    return {
      epochs: rows.map((r) => ({ epoch: r.epoch, blockCount: r.block_count })),
      lastUpdated,
    };
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

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("SQLiteAdapter not connected. Call connect() first.");
    }
    return this.db;
  }
}
