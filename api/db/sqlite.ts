// SPDX-License-Identifier: AGPL-3.0-or-later

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
  MiningSubmissionRecord,
  NodeDescriptor,
  NodeDescriptorRecord,
} from "../../src/types/telemetry";
import { Kysely } from "kysely";

import { parseIndexerObservability, type DatabaseAdapter, type DbConfig } from "./adapter";
import { SqliteDriverDialect } from "./kysely-sqlite-dialect";
import { migrateToLatest } from "./migrator";
import { Database } from "./sqlite-driver";

const DESCRIPTOR_CHECKPOINT_KEY = "descriptor_checkpoint";

const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";

// Per-miner submission checkpoint, keyed in `meta` to avoid a dedicated
// table for a single integer per miner. Multiple miners polled by one
// dashboard each get an independent cursor under `mining_checkpoint:<ss58>`.
const MINING_CHECKPOINT_KEY_PREFIX = "mining_checkpoint:";

function miningCheckpointKey(minerId: string): string {
  return `${MINING_CHECKPOINT_KEY_PREFIX}${minerId}`;
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
    const kysely = new Kysely<unknown>({ dialect: new SqliteDriverDialect(this.requireDb()) });
    await migrateToLatest(kysely, "sqlite");
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
           energy, diversity, num_valid_solutions, mining_time,
           reward, nonce, num_nodes, num_edges,
           difficulty_energy, min_diversity, min_solutions, finalized
         ) VALUES (
           $blockHash, $substrateBlockNumber, $substrateBlockHash, $substrateParentHash,
           $timestamp, $minerId,
           $energy, $diversity, $numValidSolutions, $miningTime,
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
           winning_solutions_count,
           spec_name, spec_version, transaction_version, impl_name,
           last_runtime_upgrade, updated_at
         ) VALUES (
           1, $bestNumber, $bestHash,
           $finNumber, $finHash, $finLag,
           $winSolCount,
           $specName, $specVersion, $txVersion, $implName,
           $lastUpgrade, $updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           best_block_number=excluded.best_block_number,
           best_block_hash=excluded.best_block_hash,
           finalized_block_number=excluded.finalized_block_number,
           finalized_block_hash=excluded.finalized_block_hash,
           finality_lag=excluded.finality_lag,
           winning_solutions_count=excluded.winning_solutions_count,
           spec_name=excluded.spec_name,
           spec_version=excluded.spec_version,
           transaction_version=excluded.transaction_version,
           impl_name=excluded.impl_name,
           last_runtime_upgrade=excluded.last_runtime_upgrade,
           updated_at=excluded.updated_at
         WHERE
           chain_head.best_block_number IS NOT excluded.best_block_number OR
           chain_head.finalized_block_number IS NOT excluded.finalized_block_number OR
           chain_head.winning_solutions_count IS NOT excluded.winning_solutions_count OR
           chain_head.spec_version IS NOT excluded.spec_version`,
      )
      .run({
        $bestNumber: head.bestBlockNumber,
        $bestHash: head.bestBlockHash,
        $finNumber: head.finalizedBlockNumber,
        $finHash: head.finalizedBlockHash,
        $finLag: head.finalityLag,
        $winSolCount: head.winningSolutionsCount,
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
          winning_solutions_count: number | null;
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
      winningSolutionsCount: row.winning_solutions_count,
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
    miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">>,
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

  async getChainMiners(): Promise<
    Array<Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">>
  > {
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
           (observed_at_block, difficulty_energy, min_diversity, min_solutions, observed_at)
         VALUES ($block, $energy, $div, $sol, $at)
         ON CONFLICT(observed_at_block) DO NOTHING`,
      )
      .run({
        $block: snapshot.observedAtBlock,
        $energy: snapshot.difficultyEnergy,
        $div: snapshot.minDiversity,
        $sol: snapshot.minSolutions,
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

  // --- Validator authorship (v7) ---

  async recordValidatorAuthorship(
    accountId: string,
    blockNumber: string,
    blockTimestamp: number,
    hasPow: boolean,
  ): Promise<void> {
    // unix-seconds → ISO 8601 at the adapter boundary so callers don't have
    // to know the storage format. The PoW counter increment is gated on
    // hasPow via a 0/1 sentinel reused as both the initial insert value
    // and the increment delta on conflict.
    const powDelta = hasPow ? 1 : 0;
    const lastAuthoredAt = new Date(blockTimestamp * 1000).toISOString();
    this.requireDb()
      .prepare(
        `INSERT INTO validator_authorship (
           account_id, blocks_authored, blocks_authored_with_pow,
           last_authored_block, last_authored_at
         ) VALUES ($acct, 1, $powInit, $block, $at)
         ON CONFLICT(account_id) DO UPDATE SET
           blocks_authored = validator_authorship.blocks_authored + 1,
           blocks_authored_with_pow =
             validator_authorship.blocks_authored_with_pow + $powDelta,
           last_authored_block = excluded.last_authored_block,
           last_authored_at = excluded.last_authored_at`,
      )
      .run({
        $acct: accountId,
        $powInit: powDelta,
        $powDelta: powDelta,
        $block: blockNumber,
        $at: lastAuthoredAt,
      });
  }

  async getValidatorAuthorship(): Promise<
    Array<{
      accountId: string;
      blocksAuthored: number;
      blocksAuthoredWithPow: number;
      lastAuthoredBlock: string;
      lastAuthoredAt: string;
    }>
  > {
    const rows = this.requireDb()
      .query<
        {
          account_id: string;
          blocks_authored: number;
          blocks_authored_with_pow: number;
          last_authored_block: string;
          last_authored_at: string;
        },
        []
      >("SELECT * FROM validator_authorship ORDER BY blocks_authored DESC")
      .all();
    return rows.map((r) => ({
      accountId: r.account_id,
      blocksAuthored: r.blocks_authored,
      blocksAuthoredWithPow: r.blocks_authored_with_pow,
      lastAuthoredBlock: r.last_authored_block,
      lastAuthoredAt: r.last_authored_at,
    }));
  }

  // --- Node descriptors (v11) ---

  async upsertNodeDescriptor(record: NodeDescriptorRecord): Promise<void> {
    // Tuple comparison `(a, b) < (c, d)` is the ordering tie-breaker the
    // spec calls for — newer block, or same block + later extrinsic index,
    // wins. The CAST forces numeric ordering on `block_number` (TEXT u64).
    // first_block_timestamp uses COALESCE(existing, incoming) so it sticks
    // to the first observation; ON CONFLICT DO UPDATE keeps every other
    // column on the newer payload.
    this.requireDb()
      .prepare(
        `INSERT INTO node_descriptors (
           account_id, block_number, block_hash, extrinsic_index,
           block_timestamp, first_block_timestamp, descriptor, observed_at
         ) VALUES (
           $acct, $bn, $bh, $ix, $ts, $ts, $desc, $obs
         )
         ON CONFLICT(account_id) DO UPDATE SET
           block_number     = excluded.block_number,
           block_hash       = excluded.block_hash,
           extrinsic_index  = excluded.extrinsic_index,
           block_timestamp  = excluded.block_timestamp,
           descriptor       = excluded.descriptor,
           observed_at      = excluded.observed_at
         WHERE
           (CAST(node_descriptors.block_number AS INTEGER), node_descriptors.extrinsic_index)
             < (CAST(excluded.block_number AS INTEGER), excluded.extrinsic_index)`,
      )
      .run({
        $acct: record.accountId,
        $bn: record.blockNumber,
        $bh: record.blockHash,
        $ix: record.extrinsicIndex,
        $ts: record.blockTimestamp,
        $desc: JSON.stringify(record.descriptor),
        $obs: record.observedAt,
      });
  }

  async getAllNodeDescriptors(): Promise<NodeDescriptorRecord[]> {
    const rows = this.requireDb()
      .query<
        {
          account_id: string;
          block_number: string;
          block_hash: string;
          extrinsic_index: number;
          block_timestamp: number;
          first_block_timestamp: number;
          descriptor: string;
          observed_at: string;
        },
        []
      >(
        // Sort by node_name extracted from the JSON. SQLite supports
        // `json_extract(...)`; fall back to account_id for rows with a
        // missing name (the validator forbids this, but be defensive).
        `SELECT * FROM node_descriptors
         ORDER BY COALESCE(json_extract(descriptor, '$.nodeName'), account_id)`,
      )
      .all();
    return rows.map(rowToNodeDescriptorRecord);
  }

  async getNodeDescriptor(accountId: string): Promise<NodeDescriptorRecord | null> {
    const row = this.requireDb()
      .query<
        {
          account_id: string;
          block_number: string;
          block_hash: string;
          extrinsic_index: number;
          block_timestamp: number;
          first_block_timestamp: number;
          descriptor: string;
          observed_at: string;
        },
        [string]
      >("SELECT * FROM node_descriptors WHERE account_id = ?")
      .get(accountId);
    return row ? rowToNodeDescriptorRecord(row) : null;
  }

  async getDescriptorCheckpoint(): Promise<string | null> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(DESCRIPTOR_CHECKPOINT_KEY);
    return row?.value ?? null;
  }

  async setDescriptorCheckpoint(blockNumber: string): Promise<void> {
    // Monotonic: only advance, never rewind. Guards against a misconfigured
    // restart that resumes from an earlier checkpoint than what we already
    // scanned.
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
      )
      .run({ $k: DESCRIPTOR_CHECKPOINT_KEY, $v: blockNumber });
  }

  async insertMiningSubmission(record: MiningSubmissionRecord): Promise<void> {
    // UPSERT — a submission may be re-fetched after the chain accepts it,
    // flipping chain_block_* from null to populated. All non-PK columns
    // refresh on conflict so the most recent miner view wins, including
    // observed_at (which then reads as "last fetched at").
    this.requireDb()
      .prepare(
        `INSERT INTO mining_submissions (
           miner_id, solution_number, ts_ns,
           energy_milli, diversity_milli, threshold_milli,
           last_proof_block_hash, extrinsic_hash, chain_block_hash, chain_block_number,
           pow_sequence, outcome, attempt_count, best_energy_milli, num_valid, miner_type,
           qpu_access_time_us, observed_at
         ) VALUES (
           $miner, $sol, $ts,
           $energy, $div, $thr,
           $lpbh, $extx, $cbh, $cbn,
           $powseq, $outcome, $cnt, $best, $nvalid, $mtype, $qpu, $observed
         )
         ON CONFLICT(miner_id, solution_number) DO UPDATE SET
           ts_ns                          = excluded.ts_ns,
           energy_milli                   = excluded.energy_milli,
           diversity_milli                = excluded.diversity_milli,
           threshold_milli                = excluded.threshold_milli,
           last_proof_block_hash          = excluded.last_proof_block_hash,
           extrinsic_hash                 = excluded.extrinsic_hash,
           chain_block_hash               = excluded.chain_block_hash,
           chain_block_number             = excluded.chain_block_number,
           pow_sequence                   = excluded.pow_sequence,
           outcome                        = excluded.outcome,
           attempt_count                  = excluded.attempt_count,
           best_energy_milli              = excluded.best_energy_milli,
           num_valid                      = excluded.num_valid,
           miner_type                     = excluded.miner_type,
           qpu_access_time_us             = excluded.qpu_access_time_us,
           observed_at                    = excluded.observed_at`,
      )
      .run({
        $miner: record.minerId,
        $sol: record.solutionNumber,
        $ts: record.tsNs,
        $energy: record.energyMilli,
        $div: record.diversityMilli,
        $thr: record.thresholdMilli,
        $lpbh: record.lastProofBlockHash,
        $extx: record.extrinsicHash,
        $cbh: record.chainBlockHash,
        $cbn: record.chainBlockNumber,
        $powseq: record.powSequence,
        $outcome: record.outcome,
        $cnt: record.attemptCount,
        $best: record.bestEnergyMilli,
        $nvalid: record.numValid,
        $mtype: record.minerType,
        $qpu: record.qpuAccessTimeUs,
        $observed: record.observedAt,
      });
  }

  async getRecentMiningSubmissions(
    minerId: string,
    limit: number,
  ): Promise<MiningSubmissionRecord[]> {
    const rows = this.requireDb()
      .query<
        {
          miner_id: string;
          solution_number: number;
          ts_ns: string;
          energy_milli: number;
          diversity_milli: number;
          threshold_milli: number;
          last_proof_block_hash: string;
          extrinsic_hash: string | null;
          chain_block_hash: string | null;
          chain_block_number: string | null;
          pow_sequence: number | null;
          outcome: string;
          attempt_count: number;
          best_energy_milli: number;
          num_valid: number;
          miner_type: string;
          qpu_access_time_us: number;
          observed_at: string;
        },
        [string, number]
      >(
        `SELECT * FROM mining_submissions
         WHERE miner_id = ?
         ORDER BY solution_number DESC
         LIMIT ?`,
      )
      .all(minerId, limit);
    return rows.map(rowToMiningSubmission);
  }

  async countMiningSubmissionsWithAttempts(minerId: string): Promise<number> {
    const row = this.requireDb()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM mining_submissions
         WHERE miner_id = ? AND attempt_count > 0`,
      )
      .get(minerId);
    return row?.n ?? 0;
  }

  async getMiningCheckpoint(minerId: string): Promise<number | null> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(miningCheckpointKey(minerId));
    if (!row?.value) return null;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : null;
  }

  async setMiningCheckpoint(minerId: string, solutionNumber: number): Promise<void> {
    // Monotonic advance only — same shape as setDescriptorCheckpoint. Guards
    // against a misconfigured restart that rewinds the cursor.
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
      )
      .run({ $k: miningCheckpointKey(minerId), $v: String(solutionNumber) });
  }

  async resetMiningHistory(minerId: string): Promise<void> {
    const db = this.requireDb();
    db.prepare("DELETE FROM mining_submissions WHERE miner_id = ?").run(minerId);
    db.prepare("DELETE FROM meta WHERE key = ?").run(miningCheckpointKey(minerId));
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

interface DescriptorRow {
  account_id: string;
  block_number: string;
  block_hash: string;
  extrinsic_index: number;
  block_timestamp: number;
  first_block_timestamp: number;
  descriptor: string;
  observed_at: string;
}

function rowToNodeDescriptorRecord(row: DescriptorRow): NodeDescriptorRecord {
  return {
    accountId: row.account_id,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    extrinsicIndex: row.extrinsic_index,
    blockTimestamp: row.block_timestamp,
    firstBlockTimestamp: row.first_block_timestamp,
    descriptor: JSON.parse(row.descriptor) as NodeDescriptor,
    observedAt: row.observed_at,
  };
}

function rowToMiningSubmission(row: {
  miner_id: string;
  solution_number: number;
  ts_ns: string;
  energy_milli: number;
  diversity_milli: number;
  threshold_milli: number;
  last_proof_block_hash: string;
  extrinsic_hash: string | null;
  chain_block_hash: string | null;
  chain_block_number: string | null;
  pow_sequence: number | null;
  outcome: string;
  attempt_count: number;
  best_energy_milli: number;
  num_valid: number;
  miner_type: string;
  qpu_access_time_us: number;
  observed_at: string;
}): MiningSubmissionRecord {
  return {
    minerId: row.miner_id,
    solutionNumber: row.solution_number,
    tsNs: row.ts_ns,
    energyMilli: row.energy_milli,
    diversityMilli: row.diversity_milli,
    thresholdMilli: row.threshold_milli,
    lastProofBlockHash: row.last_proof_block_hash,
    extrinsicHash: row.extrinsic_hash,
    chainBlockHash: row.chain_block_hash,
    chainBlockNumber: row.chain_block_number,
    powSequence: row.pow_sequence,
    outcome: row.outcome,
    attemptCount: row.attempt_count,
    bestEnergyMilli: row.best_energy_milli,
    numValid: row.num_valid,
    minerType: row.miner_type ?? "",
    qpuAccessTimeUs: row.qpu_access_time_us ?? 0,
    observedAt: row.observed_at,
  };
}
