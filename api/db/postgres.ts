// SPDX-License-Identifier: AGPL-3.0-or-later

import postgres, { type Sql } from "postgres";

import type {
  BlockRecord,
  IndexerCursor,
  NodesSnapshot,
  TelemetryIndex,
} from "../../src/types/telemetry";
import {
  OWNED_TABLES,
  SCHEMA_VERSION,
  isLocalDeployment,
  type DatabaseAdapter,
  type DbConfig,
} from "./adapter";

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS blocks (
     epoch               BIGINT NOT NULL,
     block_index         INTEGER NOT NULL,
     block_hash          TEXT NOT NULL,
     timestamp           BIGINT NOT NULL,
     previous_hash       TEXT NOT NULL,
     miner_id            TEXT NOT NULL,
     miner_category      TEXT NOT NULL,
     ecdsa_public_key    TEXT NOT NULL,
     energy              DOUBLE PRECISION NOT NULL,
     diversity           DOUBLE PRECISION NOT NULL,
     num_valid_solutions INTEGER NOT NULL,
     mining_time         DOUBLE PRECISION NOT NULL,
     nonce               NUMERIC NOT NULL,
     num_nodes           INTEGER NOT NULL,
     num_edges           INTEGER NOT NULL,
     difficulty_energy   DOUBLE PRECISION NOT NULL,
     min_diversity       DOUBLE PRECISION NOT NULL,
     min_solutions       INTEGER NOT NULL,
     PRIMARY KEY (epoch, block_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id)`,
  `CREATE TABLE IF NOT EXISTS nodes_snapshot (
     id      INTEGER PRIMARY KEY CHECK (id = 1),
     payload JSONB NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS indexer_state (
     id               INTEGER PRIMARY KEY CHECK (id = 1),
     cursor_epoch     BIGINT,
     cursor_block     INTEGER NOT NULL DEFAULT 0,
     last_nodes_etag  TEXT,
     updated_at       TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
];

const SELF_ADDRESS_KEY = "self_address";

interface BlockRow {
  epoch: string | number;
  block_index: number;
  block_hash: string;
  timestamp: string | number;
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

function rowToBlock(r: BlockRow): BlockRecord {
  return {
    epoch: Number(r.epoch),
    blockIndex: r.block_index,
    blockHash: r.block_hash,
    timestamp: Number(r.timestamp),
    previousHash: r.previous_hash,
    minerId: r.miner_id,
    minerCategory: r.miner_category as BlockRecord["minerCategory"],
    ecdsaPublicKey: r.ecdsa_public_key,
    energy: r.energy,
    diversity: r.diversity,
    numValidSolutions: r.num_valid_solutions,
    miningTime: r.mining_time,
    nonce: String(r.nonce),
    numNodes: r.num_nodes,
    numEdges: r.num_edges,
    difficultyEnergy: r.difficulty_energy,
    minDiversity: r.min_diversity,
    minSolutions: r.min_solutions,
  };
}

export class PostgresAdapter implements DatabaseAdapter {
  private sql: Sql | null = null;
  private readonly url: string;
  private readonly config: DbConfig;

  constructor(config: DbConfig) {
    const url = config.databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error("postgres adapter requires DATABASE_URL or config.databaseUrl");
    }
    this.url = url;
    this.config = { ...config, databaseUrl: url };
  }

  async connect(): Promise<void> {
    this.sql = postgres(this.url, { max: 4, idle_timeout: 30 });
    // Probe the connection so startup failures surface immediately.
    await this.sql`SELECT 1`;
  }

  async disconnect(): Promise<void> {
    await this.sql?.end({ timeout: 5 });
    this.sql = null;
  }

  async migrate(): Promise<void> {
    const sql = this.requireSql();
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const rows = await sql<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = 'schema_version'
    `;
    const stored =
      rows[0]?.value !== undefined && rows[0].value !== null ? Number(rows[0].value) : null;
    const local = isLocalDeployment(this.config);

    if (stored !== SCHEMA_VERSION && local) {
      // Local Postgres (e.g. docker-compose) — drop on drift. Remote Postgres
      // (Supabase etc.) never drops; schema drift there must be handled out
      // of band so production data is never wiped by a restart.
      console.warn(
        `[db] SCHEMA DRIFT detected (stored=${stored ?? "none"}, code=${SCHEMA_VERSION}); dropping all owned tables on local deployment`,
      );
      for (const table of OWNED_TABLES) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    }

    for (const stmt of SCHEMA_STATEMENTS) await sql.unsafe(stmt);
    await sql`
      INSERT INTO meta (key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async insertBlock(b: BlockRecord): Promise<boolean> {
    const sql = this.requireSql();
    const result = await sql`
      INSERT INTO blocks (
        epoch, block_index, block_hash, timestamp, previous_hash,
        miner_id, miner_category, ecdsa_public_key,
        energy, diversity, num_valid_solutions, mining_time,
        nonce, num_nodes, num_edges,
        difficulty_energy, min_diversity, min_solutions
      ) VALUES (
        ${b.epoch}, ${b.blockIndex}, ${b.blockHash}, ${b.timestamp}, ${b.previousHash},
        ${b.minerId}, ${b.minerCategory}, ${b.ecdsaPublicKey},
        ${b.energy}, ${b.diversity}, ${b.numValidSolutions}, ${b.miningTime},
        ${b.nonce}, ${b.numNodes}, ${b.numEdges},
        ${b.difficultyEnergy}, ${b.minDiversity}, ${b.minSolutions}
      )
      ON CONFLICT (epoch, block_index) DO NOTHING
    `;
    return result.count > 0;
  }

  async getAllBlocks(): Promise<BlockRecord[]> {
    const rows = await this.requireSql()<BlockRow[]>`
      SELECT * FROM blocks ORDER BY timestamp, block_index
    `;
    return rows.map(rowToBlock);
  }

  async getBlocksByEpoch(epoch: number): Promise<BlockRecord[]> {
    const rows = await this.requireSql()<BlockRow[]>`
      SELECT * FROM blocks WHERE epoch = ${epoch} ORDER BY block_index
    `;
    return rows.map(rowToBlock);
  }

  async getIndex(): Promise<TelemetryIndex> {
    const sql = this.requireSql();
    const rows = await sql<{ epoch: string | number; block_count: string | number }[]>`
      SELECT epoch, COUNT(*) AS block_count
      FROM blocks GROUP BY epoch ORDER BY epoch
    `;
    const snap = await this.getNodes();
    return {
      epochs: rows.map((r) => ({
        epoch: Number(r.epoch),
        blockCount: Number(r.block_count),
      })),
      lastUpdated: snap?.updatedAt ?? new Date().toISOString(),
    };
  }

  async upsertNodes(snapshot: NodesSnapshot): Promise<number> {
    const sql = this.requireSql();
    // postgres-js's sql.json expects a plain JSONValue-indexable object;
    // NodesSnapshot's structural type lacks the required index signature
    // but every field is JSON-serializable at runtime.
    const payload = snapshot as unknown as Parameters<typeof sql.json>[0];
    await sql`
      INSERT INTO nodes_snapshot (id, payload)
      VALUES (1, ${sql.json(payload)})
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload
    `;
    return Object.keys(snapshot.nodes).length;
  }

  async getNodes(): Promise<NodesSnapshot | null> {
    const rows = await this.requireSql()<{ payload: NodesSnapshot }[]>`
      SELECT payload FROM nodes_snapshot WHERE id = 1
    `;
    return rows[0]?.payload ?? null;
  }

  async getCursor(): Promise<IndexerCursor> {
    const rows = await this.requireSql()<{ cursor_epoch: string | null; cursor_block: number }[]>`
      SELECT cursor_epoch, cursor_block FROM indexer_state WHERE id = 1
    `;
    const row = rows[0];
    return {
      epoch: row?.cursor_epoch == null ? null : Number(row.cursor_epoch),
      blockIndex: row?.cursor_block ?? 0,
    };
  }

  async saveCursor(cursor: IndexerCursor, etags: { nodes?: string | null }): Promise<void> {
    const sql = this.requireSql();
    const nodesEtag = etags.nodes ?? null;
    await sql`
      INSERT INTO indexer_state (
        id, cursor_epoch, cursor_block, last_nodes_etag, updated_at
      ) VALUES (
        1, ${cursor.epoch}, ${cursor.blockIndex}, ${nodesEtag}, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        cursor_epoch = EXCLUDED.cursor_epoch,
        cursor_block = EXCLUDED.cursor_block,
        last_nodes_etag  = COALESCE(EXCLUDED.last_nodes_etag, indexer_state.last_nodes_etag),
        updated_at = EXCLUDED.updated_at
    `;
  }

  async getEtags(): Promise<{ nodes: string | null }> {
    const rows = await this.requireSql()<{ last_nodes_etag: string | null }[]>`
      SELECT last_nodes_etag FROM indexer_state WHERE id = 1
    `;
    const row = rows[0];
    return {
      nodes: row?.last_nodes_etag ?? null,
    };
  }

  async getSelfAddress(): Promise<string | null> {
    const rows = await this.requireSql()<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = ${SELF_ADDRESS_KEY}
    `;
    return rows[0]?.value ?? null;
  }

  async setSelfAddress(address: string | null): Promise<void> {
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${SELF_ADDRESS_KEY}, ${address})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  private requireSql(): Sql {
    if (!this.sql) {
      throw new Error("PostgresAdapter not connected. Call connect() first.");
    }
    return this.sql;
  }
}
