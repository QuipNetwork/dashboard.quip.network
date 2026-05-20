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
  IndexerObservability,
  MinerCategory,
  MinerHardwareRecord,
} from "../../src/types/telemetry";
import {
  OWNED_TABLES,
  SCHEMA_VERSION,
  parseIndexerObservability,
  type DatabaseAdapter,
  type DbConfig,
} from "./adapter";

// v5→v6 legacy tables that pre-existed the OWNED_TABLES drift sweep. Listed
// explicitly so a fresh v0.3 migrate against a v0.2 DB drops them before the
// new schema is created. After v6 ships everywhere, the inner DROPs become
// no-ops on already-clean databases.
const LEGACY_DROP_STATEMENTS: string[] = [
  "DROP TABLE IF EXISTS epoch_status",
  "DROP TABLE IF EXISTS nodes_snapshot",
  "DROP TABLE IF EXISTS self_address",
  "DROP TABLE IF EXISTS indexer_cursors",
  "DROP TABLE IF EXISTS indexer_etags",
];

const SCHEMA_STATEMENTS: string[] = [
  // Blocks: substrate worker is the sole writer in v6. Every column is
  // populated at insert time — no two-phase enrichment, no canonical flag.
  // substrate_block_number is TEXT (u64-as-string convention) but indexed
  // via CAST so DESC ordering is numeric, not lexicographic.
  `CREATE TABLE IF NOT EXISTS blocks (
     block_hash              TEXT PRIMARY KEY,
     substrate_block_number  TEXT NOT NULL,
     substrate_block_hash    TEXT NOT NULL,
     substrate_parent_hash   TEXT NOT NULL,
     timestamp               INTEGER NOT NULL,
     miner_id                TEXT NOT NULL,
     energy                  REAL NOT NULL,
     diversity               REAL NOT NULL,
     num_valid_solutions     INTEGER NOT NULL,
     quality_milli           INTEGER NOT NULL,
     mining_time             REAL NOT NULL,
     reward                  TEXT NOT NULL,
     nonce                   TEXT NOT NULL,
     num_nodes               INTEGER NOT NULL,
     num_edges               INTEGER NOT NULL,
     difficulty_energy       REAL NOT NULL,
     min_diversity           REAL NOT NULL,
     min_solutions           INTEGER NOT NULL,
     finalized               INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_substrate_number
     ON blocks(CAST(substrate_block_number AS INTEGER) DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner_id
     ON blocks(miner_id, CAST(substrate_block_number AS INTEGER) DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC)`,
  // Per-miner hardware inventory. v0.3 only writes one row (source='self').
  `CREATE TABLE IF NOT EXISTS miner_hardware (
     account_id    TEXT PRIMARY KEY,
     node_id       TEXT NOT NULL,
     miners        TEXT NOT NULL,
     primary_type  TEXT NOT NULL,
     source        TEXT NOT NULL,
     observed_at   TEXT NOT NULL
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
    // Drop v5/legacy tables before anything else. These were owned by workers
    // that no longer exist in v0.3 (epoch_status, nodes_snapshot, self_address,
    // indexer_cursors, indexer_etags). On a fresh database these are all
    // no-ops; on a v0.2 SQLite file they clear the worker-state remnants.
    for (const stmt of LEGACY_DROP_STATEMENTS) db.run(stmt);
    // meta must exist before we can read/write schema_version. Created as a
    // standalone CREATE IF NOT EXISTS so the drift check can run before we
    // apply the rest of SCHEMA_STATEMENTS.
    db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    // v4→v5 leftover: indexer_state was retired before v4 shipped and is
    // not in OWNED_TABLES, so it doesn't get dropped by the drift path.
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

  // --- Blocks ---

  async insertBlock(b: BlockRecord): Promise<void> {
    // INSERT OR IGNORE: the substrate worker is the sole writer; a PK
    // collision on block_hash is a programmatic duplicate (e.g., the same
    // head emitted twice), not a normal flow — silently skip.
    this.requireDb()
      .prepare(
        `INSERT OR IGNORE INTO blocks (
           block_hash, substrate_block_number, substrate_block_hash, substrate_parent_hash,
           timestamp, miner_id,
           energy, diversity, num_valid_solutions, quality_milli, mining_time,
           reward, nonce, num_nodes, num_edges,
           difficulty_energy, min_diversity, min_solutions, finalized
         ) VALUES (
           $blockHash, $substrateBlockNumber, $substrateBlockHash, $substrateParentHash,
           $timestamp, $minerId,
           $energy, $diversity, $numValidSolutions, $qualityMilli, $miningTime,
           $reward, $nonce, $numNodes, $numEdges,
           $difficultyEnergy, $minDiversity, $minSolutions, $finalized
         )`,
      )
      .run({
        $blockHash: b.blockHash,
        $substrateBlockNumber: b.substrateBlockNumber,
        $substrateBlockHash: b.substrateBlockHash,
        $substrateParentHash: b.substrateParentHash,
        $timestamp: b.timestamp,
        $minerId: b.minerId,
        $energy: b.energy,
        $diversity: b.diversity,
        $numValidSolutions: b.numValidSolutions,
        $qualityMilli: b.qualityMilli,
        $miningTime: b.miningTime,
        $reward: b.reward,
        $nonce: b.nonce,
        $numNodes: b.numNodes,
        $numEdges: b.numEdges,
        $difficultyEnergy: b.difficultyEnergy,
        $minDiversity: b.minDiversity,
        $minSolutions: b.minSolutions,
        $finalized: b.finalized ? 1 : 0,
      });
  }

  async getRecentBlocks(limit: number, offset: number = 0): Promise<BlockRecord[]> {
    const rows = this.requireDb()
      .query<Record<string, unknown>, [number, number]>(
        `SELECT * FROM blocks
         ORDER BY CAST(substrate_block_number AS INTEGER) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    return rows.map(rowToBlockRecord);
  }

  async getBlocksByMiner(minerId: string, limit: number): Promise<BlockRecord[]> {
    const rows = this.requireDb()
      .query<Record<string, unknown>, [string, number]>(
        `SELECT * FROM blocks
         WHERE miner_id = ?
         ORDER BY CAST(substrate_block_number AS INTEGER) DESC
         LIMIT ?`,
      )
      .all(minerId, limit);
    return rows.map(rowToBlockRecord);
  }

  async markBlockFinalized(blockHash: string): Promise<void> {
    // Monotonic: only flip 0 → 1. Idempotent — already-finalized rows and
    // unknown hashes both become no-ops by the WHERE clause.
    this.requireDb()
      .prepare("UPDATE blocks SET finalized = 1 WHERE block_hash = ? AND finalized = 0")
      .run(blockHash);
  }

  // --- Self-identity ---

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

  // --- Indexer observability ---

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

  /** @internal test-only — write a raw value under a meta key. */
  async setMetaRaw(key: string, value: string): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: key, $v: value });
  }

  // --- Substrate-derived state (unchanged from v5) ---

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

  // --- Miner hardware ---

  async upsertMinerHardware(record: MinerHardwareRecord): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO miner_hardware (account_id, node_id, miners, primary_type, source, observed_at)
         VALUES ($acct, $node, $miners, $primary, $source, $observedAt)
         ON CONFLICT(account_id) DO UPDATE SET
           node_id      = excluded.node_id,
           miners       = excluded.miners,
           primary_type = excluded.primary_type,
           source       = excluded.source,
           observed_at  = excluded.observed_at`,
      )
      .run({
        $acct: record.accountId,
        $node: record.nodeId,
        $miners: JSON.stringify(record.miners),
        $primary: record.primaryType,
        $source: record.source,
        $observedAt: record.observedAt,
      });
  }

  async getMinerHardware(accountId: string): Promise<MinerHardwareRecord | null> {
    const row = this.requireDb()
      .query<Record<string, unknown>, [string]>("SELECT * FROM miner_hardware WHERE account_id = ?")
      .get(accountId);
    if (!row) return null;
    return rowToMinerHardware(row);
  }

  async getAllMinerHardware(): Promise<MinerHardwareRecord[]> {
    const rows = this.requireDb()
      .query<Record<string, unknown>, []>("SELECT * FROM miner_hardware ORDER BY observed_at DESC")
      .all();
    return rows.map(rowToMinerHardware);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("SQLiteAdapter not connected. Call connect() first.");
    }
    return this.db;
  }
}

function rowToBlockRecord(row: Record<string, unknown>): BlockRecord {
  return {
    blockHash: String(row.block_hash),
    substrateBlockNumber: String(row.substrate_block_number),
    substrateBlockHash: String(row.substrate_block_hash),
    substrateParentHash: String(row.substrate_parent_hash),
    timestamp: Number(row.timestamp),
    minerId: String(row.miner_id),
    energy: Number(row.energy),
    diversity: Number(row.diversity),
    numValidSolutions: Number(row.num_valid_solutions),
    qualityMilli: Number(row.quality_milli),
    miningTime: Number(row.mining_time),
    reward: String(row.reward),
    nonce: String(row.nonce),
    numNodes: Number(row.num_nodes),
    numEdges: Number(row.num_edges),
    difficultyEnergy: Number(row.difficulty_energy),
    minDiversity: Number(row.min_diversity),
    minSolutions: Number(row.min_solutions),
    finalized: row.finalized === 1 || row.finalized === true,
  };
}

function rowToMinerHardware(row: Record<string, unknown>): MinerHardwareRecord {
  const miners = JSON.parse(String(row.miners)) as Array<{ id: string; type: MinerCategory }>;
  return {
    accountId: String(row.account_id),
    nodeId: String(row.node_id),
    miners,
    primaryType: String(row.primary_type) as MinerCategory,
    source: String(row.source) as MinerHardwareRecord["source"],
    observedAt: String(row.observed_at),
  };
}
