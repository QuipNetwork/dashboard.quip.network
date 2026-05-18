// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
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
  parseIndexerCursors,
  parseIndexerCursorsOrDefault,
  parseIndexerObservability,
  type DatabaseAdapter,
  type DbConfig,
  type EpochStatusEntry,
} from "./adapter";

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS blocks (
     epoch                  TEXT NOT NULL,
     block_index            INTEGER NOT NULL,
     block_hash             TEXT NOT NULL,
     timestamp              INTEGER NOT NULL,
     previous_hash          TEXT NOT NULL,
     miner_id               TEXT NOT NULL,
     miner_category         TEXT NOT NULL,
     ecdsa_public_key       TEXT NOT NULL,
     energy                 REAL NOT NULL,
     diversity              REAL NOT NULL,
     num_valid_solutions    INTEGER NOT NULL,
     mining_time            REAL NOT NULL,
     nonce                  TEXT NOT NULL,
     num_nodes              INTEGER NOT NULL,
     num_edges              INTEGER NOT NULL,
     difficulty_energy      REAL NOT NULL,
     min_diversity          REAL NOT NULL,
     min_solutions          INTEGER NOT NULL,
     substrate_block_number TEXT,
     substrate_block_hash   TEXT,
     substrate_parent_hash  TEXT,
     extrinsics_root        TEXT,
     state_root             TEXT,
     finalized              INTEGER NOT NULL DEFAULT 0,
     is_canonical           INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (epoch, block_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id)`,
  // Composite supports the default canonical-only read path and the
  // miner+energy join used by the substrate worker's BlockWinner
  // correlation (findBlockByMinerAndEnergy).
  `CREATE INDEX IF NOT EXISTS idx_blocks_canonical_ts ON blocks(is_canonical, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_substrate_hash ON blocks(substrate_block_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_substrate_number ON blocks(substrate_block_number)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_finalized ON blocks(finalized)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner_energy ON blocks(miner_id, energy, timestamp DESC)`,
  `CREATE TABLE IF NOT EXISTS nodes_snapshot (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     payload    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS epoch_status (
     epoch         TEXT PRIMARY KEY,
     status        TEXT NOT NULL CHECK (status IN ('live','stale_fork')),
     chain_anchor  TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
  // v5 substrate-derived tables. Field shapes mirror src/types/telemetry.ts.
  `CREATE TABLE IF NOT EXISTS chain_head (
     id                      INTEGER PRIMARY KEY CHECK (id = 1),
     best_block_number       TEXT NOT NULL,
     best_block_hash         TEXT NOT NULL,
     finalized_block_number  TEXT NOT NULL,
     finalized_block_hash    TEXT NOT NULL,
     finality_lag            INTEGER NOT NULL,
     spec_name               TEXT NOT NULL,
     spec_version            INTEGER NOT NULL,
     transaction_version     INTEGER NOT NULL,
     impl_name               TEXT NOT NULL,
     last_runtime_upgrade    TEXT,
     updated_at              TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS babe_epochs (
     epoch_index             INTEGER PRIMARY KEY,
     current_slot            TEXT NOT NULL,
     epoch_start_slot        TEXT NOT NULL,
     slots_per_epoch         INTEGER NOT NULL,
     current_slot_in_epoch   INTEGER NOT NULL,
     authority_count         INTEGER NOT NULL,
     is_current              INTEGER NOT NULL DEFAULT 0,
     updated_at              TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_babe_epochs_current ON babe_epochs(is_current)`,
  `CREATE TABLE IF NOT EXISTS babe_authorities (
     account_id    TEXT NOT NULL,
     epoch_index   INTEGER NOT NULL,
     display_name  TEXT,
     is_active     INTEGER NOT NULL DEFAULT 0,
     updated_at    TEXT NOT NULL,
     PRIMARY KEY (account_id, epoch_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_babe_authorities_active
     ON babe_authorities(epoch_index, is_active)`,
  `CREATE TABLE IF NOT EXISTS chain_miners (
     account_id        TEXT PRIMARY KEY,
     deposit           TEXT NOT NULL,
     proofs_submitted  TEXT NOT NULL,
     proofs_won        TEXT NOT NULL,
     rewards_earned    TEXT NOT NULL,
     updated_at        TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS difficulty_history (
     observed_at_block  TEXT PRIMARY KEY,
     difficulty_energy  REAL NOT NULL,
     min_diversity      REAL NOT NULL,
     min_solutions      INTEGER NOT NULL,
     min_quality        REAL NOT NULL,
     observed_at        TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_difficulty_history_observed
     ON difficulty_history(observed_at DESC)`,
];

const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";
const INDEXER_CURSORS_KEY = "indexer_cursors";

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
  substrate_block_number: string | null;
  substrate_block_hash: string | null;
  substrate_parent_hash: string | null;
  extrinsics_root: string | null;
  state_root: string | null;
  finalized: number;
  is_canonical: number;
}

interface EpochIndexRow {
  epoch: string;
  block_count: number;
  status: string | null;
  first_block_timestamp: number | null;
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
    substrateBlockNumber: r.substrate_block_number,
    substrateBlockHash: r.substrate_block_hash,
    substrateParentHash: r.substrate_parent_hash,
    extrinsicsRoot: r.extrinsics_root,
    stateRoot: r.state_root,
    finalized: r.finalized !== 0,
    isCanonical: r.is_canonical !== 0,
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
    // v4→v5 leftover: indexer_state was retired before v4 shipped and is
    // not in OWNED_TABLES, so it doesn't get dropped by the drift path.
    // Sweep it once on every v5 migrate. After v5 ships, becomes a no-op.
    db.run(`DROP TABLE IF EXISTS indexer_state`);
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
    // Substrate-side fields (substrateBlockNumber/Hash/etc., finalized) are
    // filled by the substrate worker via updateBlockSubstrateFields after
    // insert. We write the explicit NULLs / defaults here so the row shape
    // is uniform regardless of whether the BlockRecord carries them.
    const result = this.requireDb()
      .prepare(
        `INSERT OR IGNORE INTO blocks (
           epoch, block_index, block_hash, timestamp, previous_hash,
           miner_id, miner_category, ecdsa_public_key,
           energy, diversity, num_valid_solutions, mining_time,
           nonce, num_nodes, num_edges,
           difficulty_energy, min_diversity, min_solutions,
           substrate_block_number, substrate_block_hash, substrate_parent_hash,
           extrinsics_root, state_root, finalized, is_canonical
         ) VALUES (
           $epoch, $blockIndex, $blockHash, $timestamp, $previousHash,
           $minerId, $minerCategory, $ecdsaPublicKey,
           $energy, $diversity, $numValidSolutions, $miningTime,
           $nonce, $numNodes, $numEdges,
           $difficultyEnergy, $minDiversity, $minSolutions,
           $substrateBlockNumber, $substrateBlockHash, $substrateParentHash,
           $extrinsicsRoot, $stateRoot, $finalized, $isCanonical
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
        $substrateBlockNumber: b.substrateBlockNumber,
        $substrateBlockHash: b.substrateBlockHash,
        $substrateParentHash: b.substrateParentHash,
        $extrinsicsRoot: b.extrinsicsRoot,
        $stateRoot: b.stateRoot,
        $finalized: b.finalized ? 1 : 0,
        $isCanonical: b.isCanonical ? 1 : 0,
      });
    return result.changes > 0;
  }

  async getAllBlocks(): Promise<BlockRecord[]> {
    // Default-filter stale-fork blocks (audit fix #5) — views that need
    // all chains can call a future getAllBlocksIncludingForks helper.
    const rows = this.requireDb()
      .query("SELECT * FROM blocks WHERE is_canonical = 1 ORDER BY timestamp, block_index")
      .all() as BlockRow[];
    return rows.map(rowToBlock);
  }

  async getBlocksByEpoch(epoch: EpochId): Promise<BlockRecord[]> {
    // No canonical filter here — caller asked for a specific epoch.
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

  async getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(INDEXER_CURSORS_KEY);
    return parseIndexerCursorsOrDefault(row?.value ?? null, "sqlite");
  }

  async saveCursors(
    tip: IndexerCursor,
    backfill: IndexerCursor,
    etags: { nodes?: string | null },
  ): Promise<void> {
    const payload = JSON.stringify({
      tip,
      backfill,
      etags: { nodes: etags.nodes ?? null },
    });
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: INDEXER_CURSORS_KEY, $v: payload });
  }

  async getEtags(): Promise<{ nodes: string | null }> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(INDEXER_CURSORS_KEY);
    const parsed = parseIndexerCursors(row?.value ?? null);
    return { nodes: parsed?.etags?.nodes ?? null };
  }

  /** @internal test-only — write a raw value under a meta key. */
  async setMetaRaw(key: string, value: string): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: key, $v: value });
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

  // --- Substrate-derived state (v5) ---

  async upsertChainHead(head: ChainHead): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO chain_head (
           id, best_block_number, best_block_hash,
           finalized_block_number, finalized_block_hash, finality_lag,
           spec_name, spec_version, transaction_version, impl_name,
           last_runtime_upgrade, updated_at
         ) VALUES (
           1, $bestNumber, $bestHash,
           $finNumber, $finHash, $finLag,
           $specName, $specVersion, $txVersion, $implName,
           $lastUpgrade, $updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           best_block_number=excluded.best_block_number,
           best_block_hash=excluded.best_block_hash,
           finalized_block_number=excluded.finalized_block_number,
           finalized_block_hash=excluded.finalized_block_hash,
           finality_lag=excluded.finality_lag,
           spec_name=excluded.spec_name,
           spec_version=excluded.spec_version,
           transaction_version=excluded.transaction_version,
           impl_name=excluded.impl_name,
           last_runtime_upgrade=excluded.last_runtime_upgrade,
           updated_at=excluded.updated_at
         WHERE
           chain_head.best_block_number IS NOT excluded.best_block_number OR
           chain_head.finalized_block_number IS NOT excluded.finalized_block_number OR
           chain_head.spec_version IS NOT excluded.spec_version`,
      )
      .run({
        $bestNumber: head.bestBlockNumber,
        $bestHash: head.bestBlockHash,
        $finNumber: head.finalizedBlockNumber,
        $finHash: head.finalizedBlockHash,
        $finLag: head.finalityLag,
        $specName: head.runtime.specName,
        $specVersion: head.runtime.specVersion,
        $txVersion: head.runtime.transactionVersion,
        $implName: head.runtime.implName,
        $lastUpgrade: head.runtime.lastRuntimeUpgrade,
        $updatedAt: head.updatedAt,
      });
  }

  async getChainHead(): Promise<ChainHead | null> {
    const row = this.requireDb()
      .query<
        {
          best_block_number: string;
          best_block_hash: string;
          finalized_block_number: string;
          finalized_block_hash: string;
          finality_lag: number;
          spec_name: string;
          spec_version: number;
          transaction_version: number;
          impl_name: string;
          last_runtime_upgrade: string | null;
          updated_at: string;
        },
        []
      >("SELECT * FROM chain_head WHERE id = 1")
      .get();
    if (!row) return null;
    return {
      bestBlockNumber: row.best_block_number,
      bestBlockHash: row.best_block_hash,
      finalizedBlockNumber: row.finalized_block_number,
      finalizedBlockHash: row.finalized_block_hash,
      finalityLag: row.finality_lag,
      runtime: {
        specName: row.spec_name,
        specVersion: row.spec_version,
        transactionVersion: row.transaction_version,
        implName: row.impl_name,
        lastRuntimeUpgrade: row.last_runtime_upgrade,
      },
      updatedAt: row.updated_at,
    };
  }

  async upsertBabeEpoch(epoch: BabeEpochState): Promise<void> {
    const db = this.requireDb();
    db.transaction(() => {
      db.run("UPDATE babe_epochs SET is_current = 0 WHERE is_current = 1 AND epoch_index != ?", [
        epoch.epochIndex,
      ]);
      db.prepare(
        `INSERT INTO babe_epochs (
           epoch_index, current_slot, epoch_start_slot,
           slots_per_epoch, current_slot_in_epoch, authority_count,
           is_current, updated_at
         ) VALUES (
           $idx, $slot, $startSlot,
           $perEpoch, $inEpoch, $authCount,
           1, $updatedAt
         )
         ON CONFLICT(epoch_index) DO UPDATE SET
           current_slot=excluded.current_slot,
           epoch_start_slot=excluded.epoch_start_slot,
           slots_per_epoch=excluded.slots_per_epoch,
           current_slot_in_epoch=excluded.current_slot_in_epoch,
           authority_count=excluded.authority_count,
           is_current=1,
           updated_at=excluded.updated_at`,
      ).run({
        $idx: epoch.epochIndex,
        $slot: epoch.currentSlot,
        $startSlot: epoch.epochStartSlot,
        $perEpoch: epoch.slotsPerEpoch,
        $inEpoch: epoch.currentSlotInEpoch,
        $authCount: epoch.authorityCount,
        $updatedAt: new Date().toISOString(),
      });
    })();
  }

  async getCurrentBabeEpoch(): Promise<BabeEpochState | null> {
    const row = this.requireDb()
      .query<
        {
          epoch_index: number;
          current_slot: string;
          epoch_start_slot: string;
          slots_per_epoch: number;
          current_slot_in_epoch: number;
          authority_count: number;
        },
        []
      >("SELECT * FROM babe_epochs WHERE is_current = 1 LIMIT 1")
      .get();
    if (!row) return null;
    return {
      epochIndex: row.epoch_index,
      currentSlot: row.current_slot,
      epochStartSlot: row.epoch_start_slot,
      slotsPerEpoch: row.slots_per_epoch,
      currentSlotInEpoch: row.current_slot_in_epoch,
      authorityCount: row.authority_count,
    };
  }

  async upsertBabeAuthorities(
    epochIndex: number,
    authorities: BabeAuthorityRecord[],
  ): Promise<void> {
    const db = this.requireDb();
    const upsert = db.prepare(
      `INSERT INTO babe_authorities (account_id, epoch_index, display_name, is_active, updated_at)
       VALUES ($acct, $idx, $name, 1, $updatedAt)
       ON CONFLICT(account_id, epoch_index) DO UPDATE SET
         display_name=excluded.display_name,
         is_active=1,
         updated_at=excluded.updated_at`,
    );
    db.transaction(() => {
      const incoming = new Set(authorities.map((a) => a.accountId));
      const existing = db
        .query<
          { account_id: string },
          [number]
        >("SELECT account_id FROM babe_authorities WHERE epoch_index = ? AND is_active = 1")
        .all(epochIndex);
      for (const row of existing) {
        if (!incoming.has(row.account_id)) {
          db.run(
            "UPDATE babe_authorities SET is_active = 0, updated_at = ? WHERE account_id = ? AND epoch_index = ?",
            [new Date().toISOString(), row.account_id, epochIndex],
          );
        }
      }
      for (const a of authorities) {
        upsert.run({
          $acct: a.accountId,
          $idx: epochIndex,
          $name: a.displayName,
          $updatedAt: new Date().toISOString(),
        });
      }
    })();
  }

  async getActiveBabeAuthorities(): Promise<BabeAuthorityRecord[]> {
    const rows = this.requireDb()
      .query<{ account_id: string; display_name: string | null }, []>(
        `SELECT account_id, display_name FROM babe_authorities
         WHERE epoch_index = (SELECT epoch_index FROM babe_epochs WHERE is_current = 1 LIMIT 1)
           AND is_active = 1
         ORDER BY account_id`,
      )
      .all();
    return rows.map((r) => ({ accountId: r.account_id, displayName: r.display_name }));
  }

  async upsertChainMiners(
    miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>,
  ): Promise<void> {
    const db = this.requireDb();
    const upsert = db.prepare(
      `INSERT INTO chain_miners (account_id, deposit, proofs_submitted, proofs_won, rewards_earned, updated_at)
       VALUES ($acct, $deposit, $subs, $won, $rewards, $updatedAt)
       ON CONFLICT(account_id) DO UPDATE SET
         deposit=excluded.deposit,
         proofs_submitted=excluded.proofs_submitted,
         proofs_won=excluded.proofs_won,
         rewards_earned=excluded.rewards_earned,
         updated_at=excluded.updated_at
       WHERE
         chain_miners.deposit IS NOT excluded.deposit OR
         chain_miners.proofs_submitted IS NOT excluded.proofs_submitted OR
         chain_miners.proofs_won IS NOT excluded.proofs_won OR
         chain_miners.rewards_earned IS NOT excluded.rewards_earned`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const m of miners) {
        upsert.run({
          $acct: m.accountId,
          $deposit: m.deposit,
          $subs: m.proofsSubmitted,
          $won: m.proofsWon,
          $rewards: m.rewardsEarned,
          $updatedAt: now,
        });
      }
    })();
  }

  async getChainMiners(): Promise<Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>> {
    const rows = this.requireDb()
      .query<
        {
          account_id: string;
          deposit: string;
          proofs_submitted: string;
          proofs_won: string;
          rewards_earned: string;
        },
        []
      >(
        // Order by rewards (descending) so leaderboards work without
        // sort-in-app. Cast through REAL because rewards_earned is TEXT
        // (u128) — collation order on TEXT would be lexicographic.
        "SELECT * FROM chain_miners ORDER BY CAST(rewards_earned AS REAL) DESC",
      )
      .all();
    return rows.map((r) => ({
      accountId: r.account_id,
      deposit: r.deposit,
      proofsSubmitted: r.proofs_submitted,
      proofsWon: r.proofs_won,
      rewardsEarned: r.rewards_earned,
    }));
  }

  async insertDifficultySnapshot(snapshot: DifficultyRecord): Promise<void> {
    // Append-only. Worker dedupes; ON CONFLICT DO NOTHING covers the race
    // where two boundary blocks at the same height get re-emitted (e.g.,
    // reorg replay).
    this.requireDb()
      .prepare(
        `INSERT INTO difficulty_history
           (observed_at_block, difficulty_energy, min_diversity, min_solutions, min_quality, observed_at)
         VALUES ($block, $energy, $div, $sol, $qual, $at)
         ON CONFLICT(observed_at_block) DO NOTHING`,
      )
      .run({
        $block: snapshot.observedAtBlock,
        $energy: snapshot.difficultyEnergy,
        $div: snapshot.minDiversity,
        $sol: snapshot.minSolutions,
        $qual: snapshot.minQuality,
        $at: snapshot.observedAt,
      });
  }

  async getRecentDifficulty(limit: number): Promise<DifficultyRecord[]> {
    const rows = this.requireDb()
      .query<
        {
          observed_at_block: string;
          difficulty_energy: number;
          min_diversity: number;
          min_solutions: number;
          min_quality: number;
          observed_at: string;
        },
        [number]
      >("SELECT * FROM difficulty_history ORDER BY observed_at DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => ({
      observedAtBlock: r.observed_at_block,
      difficultyEnergy: r.difficulty_energy,
      minDiversity: r.min_diversity,
      minSolutions: r.min_solutions,
      minQuality: r.min_quality,
      observedAt: r.observed_at,
    }));
  }

  async updateBlockSubstrateFields(
    epoch: EpochId,
    blockIndex: number,
    fields: Partial<{
      substrateBlockNumber: string;
      substrateBlockHash: string;
      substrateParentHash: string;
      extrinsicsRoot: string;
      stateRoot: string;
      finalized: boolean;
    }>,
  ): Promise<{ matched: boolean }> {
    const setClauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (fields.substrateBlockNumber !== undefined) {
      setClauses.push("substrate_block_number = COALESCE(?, substrate_block_number)");
      params.push(fields.substrateBlockNumber);
    }
    if (fields.substrateBlockHash !== undefined) {
      setClauses.push("substrate_block_hash = COALESCE(?, substrate_block_hash)");
      params.push(fields.substrateBlockHash);
    }
    if (fields.substrateParentHash !== undefined) {
      setClauses.push("substrate_parent_hash = COALESCE(?, substrate_parent_hash)");
      params.push(fields.substrateParentHash);
    }
    if (fields.extrinsicsRoot !== undefined) {
      setClauses.push("extrinsics_root = COALESCE(?, extrinsics_root)");
      params.push(fields.extrinsicsRoot);
    }
    if (fields.stateRoot !== undefined) {
      setClauses.push("state_root = COALESCE(?, state_root)");
      params.push(fields.stateRoot);
    }
    if (fields.finalized === true) {
      // Monotonic: only flip 0 → 1. Never sets back to 0 here — that
      // would require an explicit reorg path.
      setClauses.push("finalized = 1");
    }
    if (setClauses.length === 0) {
      return { matched: true };
    }
    params.push(epoch, blockIndex);
    const result = this.requireDb()
      .prepare(`UPDATE blocks SET ${setClauses.join(", ")} WHERE epoch = ? AND block_index = ?`)
      .run(...params);
    return { matched: result.changes > 0 };
  }

  async findBlockByMinerAndEnergy(
    minerId: string,
    energy: number,
  ): Promise<{ epoch: EpochId; blockIndex: number } | null> {
    // Energy is a float; rely on exact equality (the REST API and the
    // chain event report the same numeric value). If precision drift
    // appears in production, switch to ABS(energy - ?) < 1e-6 here.
    const row = this.requireDb()
      .query<
        { epoch: string; block_index: number },
        [string, number]
      >("SELECT epoch, block_index FROM blocks WHERE miner_id = ? AND energy = ? ORDER BY timestamp DESC LIMIT 1")
      .get(minerId, energy);
    if (!row) return null;
    return { epoch: row.epoch, blockIndex: row.block_index };
  }

  async markBlocksCanonical(epochs: EpochId[], canonical: boolean): Promise<void> {
    if (epochs.length === 0) return;
    const placeholders = epochs.map(() => "?").join(",");
    this.requireDb()
      .prepare(`UPDATE blocks SET is_canonical = ? WHERE epoch IN (${placeholders})`)
      .run(canonical ? 1 : 0, ...epochs);
  }

  async updateEpochChainAnchor(epoch: EpochId, chainAnchor: string): Promise<void> {
    this.requireDb()
      .prepare("UPDATE epoch_status SET chain_anchor = ? WHERE epoch = ?")
      .run(chainAnchor, epoch);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("SQLiteAdapter not connected. Call connect() first.");
    }
    return this.db;
  }
}
