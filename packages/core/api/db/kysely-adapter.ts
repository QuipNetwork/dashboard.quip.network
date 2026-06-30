// SPDX-License-Identifier: AGPL-3.0-or-later

import { Kysely, sql, type RawBuilder } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres, { type Sql } from "postgres";

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  MineableTopologyRecord,
  MinerHardwareRecord,
  MiningSubmissionRecord,
  NodeDescriptorRecord,
} from "@quip/shared/telemetry";
import { chunk } from "@quip/shared/array";
import { parseIndexerObservability, type DatabaseAdapter, type DbConfig } from "./adapter";
import {
  migrateToLatest,
  migrationStatus,
  pendingMigrations,
  type MigrationStatusRow,
} from "./migrator";
import {
  rowToBabeEpoch,
  rowToBlockRecord,
  rowToChainHead,
  rowToChainMiner,
  rowToDifficulty,
  rowToMinerHardware,
  rowToMiningSubmission,
  rowToNodeDescriptor,
  rowToValidatorAuthorship,
} from "./row-mappers";
import type { DB } from "./schema-types";

const DESCRIPTOR_CHECKPOINT_KEY = "descriptor_checkpoint";
const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";
const MINEABLE_TOPOLOGIES_KEY = "mineable_topologies";
const MINING_CHECKPOINT_KEY_PREFIX = "mining_checkpoint:";

function miningCheckpointKey(minerId: string): string {
  return `${MINING_CHECKPOINT_KEY_PREFIX}${minerId}`;
}

// Postgres encodes a statement's bound-parameter count as an int16, capping it
// at 65535. Multi-row INSERTs and large IN-lists bind one parameter per value,
// so they must be split to stay under that ceiling. 10k is well under the limit
// with generous headroom and keeps each statement's lock/memory footprint small.
const PG_MAX_BIND_PARAMS = 10_000;

// Split `rows` so each chunk binds at most PG_MAX_BIND_PARAMS parameters, given
// `columnsPerRow` parameters per row (always at least one row per chunk).
function chunkForParams<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  return chunk(rows, Math.max(1, Math.floor(PG_MAX_BIND_PARAMS / Math.max(1, columnsPerRow))));
}

type ChainMinerLite = Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">;

// A Postgres adapter over Kysely (postgres-js). Reads are normalised by the
// shared row mappers; writes pass JS values straight through.
const DEFAULT_POOL_MAX = 10;

export class KyselyAdapter implements DatabaseAdapter {
  private readonly url: string | undefined;
  private readonly poolMax: number;
  private db: Kysely<DB> | null = null;
  private sqlClient: Sql | null = null;
  // Test seam: an externally-built Kysely (e.g. over pglite). When present,
  // connect()/disconnect() use it instead of opening a real connection, and
  // the caller owns its lifecycle via onClose.
  private readonly injected: { db: Kysely<DB>; onClose?: () => Promise<void> } | null;

  constructor(config: DbConfig, injected?: { db: Kysely<DB>; onClose?: () => Promise<void> }) {
    this.url = config.databaseUrl ?? process.env.DATABASE_URL;
    this.poolMax = config.poolMax ?? DEFAULT_POOL_MAX;
    this.injected = injected ?? null;
    if (!this.url && !this.injected) {
      throw new Error("KyselyAdapter requires DATABASE_URL or config.databaseUrl");
    }
  }

  async connect(): Promise<void> {
    if (this.injected) {
      this.db = this.injected.db;
      return;
    }
    this.sqlClient = postgres(this.url as string, {
      max: this.poolMax,
      idle_timeout: 30,
      // Migrations issue DROP TABLE IF EXISTS; silence the resulting NOTICEs.
      onnotice: () => {},
    });
    await this.sqlClient`SELECT 1`;
    this.db = new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: this.sqlClient }) });
  }

  async disconnect(): Promise<void> {
    if (this.injected) {
      await this.injected.onClose?.();
      this.db = null;
      return;
    }
    if (this.sqlClient) {
      await this.sqlClient.end({ timeout: 5 });
      this.sqlClient = null;
    }
    this.db = null;
  }

  async migrate(): Promise<void> {
    await migrateToLatest(this.migratorDb());
  }

  async migrationStatus(): Promise<MigrationStatusRow[]> {
    return migrationStatus(this.migratorDb());
  }

  async pendingMigrations(): Promise<string[]> {
    return pendingMigrations(this.migratorDb());
  }

  // --- Blocks ---

  async insertBlock(b: BlockRecord): Promise<void> {
    await this.requireDb()
      .insertInto("blocks")
      .values({
        block_hash: b.blockHash,
        substrate_block_number: b.substrateBlockNumber,
        substrate_block_hash: b.substrateBlockHash,
        substrate_parent_hash: b.substrateParentHash,
        timestamp: b.timestamp,
        miner_id: b.minerId,
        energy: b.energy,
        diversity: b.diversity,
        num_valid_solutions: b.numValidSolutions,
        mining_time: b.miningTime,
        reward: b.reward,
        qblock_id: b.qblockId,
        nonce: b.nonce,
        num_nodes: b.numNodes,
        num_edges: b.numEdges,
        difficulty_energy: b.difficultyEnergy,
        min_diversity: b.minDiversity,
        min_solutions: b.minSolutions,
        finalized: b.finalized,
        topology_hash: b.topologyHash,
      })
      .onConflict((oc) => oc.column("block_hash").doNothing())
      .execute();
  }

  async getRecentBlocks(limit: number, offset: number = 0): Promise<BlockRecord[]> {
    const rows = await this.requireDb()
      .selectFrom("blocks")
      .selectAll()
      .orderBy("substrate_block_number", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map(rowToBlockRecord);
  }

  async getBlocksByMiner(minerId: string, limit: number): Promise<BlockRecord[]> {
    const rows = await this.requireDb()
      .selectFrom("blocks")
      .selectAll()
      .where("miner_id", "=", minerId)
      .orderBy("substrate_block_number", "desc")
      .limit(limit)
      .execute();
    return rows.map(rowToBlockRecord);
  }

  async getExistingBlockNumbers(blockNumbers: string[]): Promise<string[]> {
    if (blockNumbers.length === 0) return [];
    const out: string[] = [];
    // One bind parameter per number, so chunk the IN-list under the ceiling.
    for (const batch of chunk(blockNumbers, PG_MAX_BIND_PARAMS)) {
      const rows = await this.requireDb()
        .selectFrom("blocks")
        .select("substrate_block_number")
        .where("substrate_block_number", "in", batch)
        .execute();
      for (const r of rows) out.push(String(r.substrate_block_number));
    }
    return out;
  }

  async markBlockFinalized(blockHash: string): Promise<void> {
    await this.requireDb()
      .updateTable("blocks")
      .set({ finalized: true })
      .where("block_hash", "=", blockHash)
      .where("finalized", "=", false)
      .execute();
  }

  // --- Self-identity ---

  async getSelfAddress(): Promise<string | null> {
    return this.getMeta(SELF_ADDRESS_KEY);
  }

  async setSelfAddress(address: string | null): Promise<void> {
    await this.setMeta(SELF_ADDRESS_KEY, address);
  }

  // --- Indexer observability ---

  async getIndexerObservability(): Promise<IndexerObservability | null> {
    const raw = await this.getMeta(INDEXER_OBSERVABILITY_KEY);
    if (!raw) return null;
    return parseIndexerObservability(raw);
  }

  async setIndexerObservability(obs: IndexerObservability): Promise<void> {
    await this.setMeta(INDEXER_OBSERVABILITY_KEY, JSON.stringify(obs));
  }

  /** @internal test-only — write a raw value under a meta key. */
  async setMetaRaw(key: string, value: string): Promise<void> {
    await this.setMeta(key, value);
  }

  // --- Substrate-derived state ---

  async upsertChainHead(head: ChainHead): Promise<void> {
    const distinct = this.distinctOp();
    await this.requireDb()
      .insertInto("chain_head")
      .values({
        id: 1,
        best_block_number: head.bestBlockNumber,
        best_block_hash: head.bestBlockHash,
        finalized_block_number: head.finalizedBlockNumber,
        finalized_block_hash: head.finalizedBlockHash,
        finality_lag: head.finalityLag,
        winning_solutions_count: head.winningSolutionsCount,
        current_qblock_id: head.currentQBlockId,
        current_qblock_participants: head.currentQBlockParticipants,
        spec_name: head.runtime.specName,
        spec_version: head.runtime.specVersion,
        transaction_version: head.runtime.transactionVersion,
        impl_name: head.runtime.implName,
        last_runtime_upgrade: head.runtime.lastRuntimeUpgrade,
        updated_at: head.updatedAt,
      })
      .onConflict((oc) =>
        oc
          .column("id")
          .doUpdateSet({
            best_block_number: sql`excluded.best_block_number`,
            best_block_hash: sql`excluded.best_block_hash`,
            finalized_block_number: sql`excluded.finalized_block_number`,
            finalized_block_hash: sql`excluded.finalized_block_hash`,
            finality_lag: sql`excluded.finality_lag`,
            winning_solutions_count: sql`excluded.winning_solutions_count`,
            current_qblock_id: sql`excluded.current_qblock_id`,
            current_qblock_participants: sql`excluded.current_qblock_participants`,
            spec_name: sql`excluded.spec_name`,
            spec_version: sql`excluded.spec_version`,
            transaction_version: sql`excluded.transaction_version`,
            impl_name: sql`excluded.impl_name`,
            last_runtime_upgrade: sql`excluded.last_runtime_upgrade`,
            updated_at: sql`excluded.updated_at`,
          })
          .where(
            sql<boolean>`
              chain_head.best_block_number ${distinct} excluded.best_block_number or
              chain_head.finalized_block_number ${distinct} excluded.finalized_block_number or
              chain_head.winning_solutions_count ${distinct} excluded.winning_solutions_count or
              chain_head.current_qblock_id ${distinct} excluded.current_qblock_id or
              chain_head.current_qblock_participants ${distinct} excluded.current_qblock_participants or
              chain_head.spec_version ${distinct} excluded.spec_version
            `,
          ),
      )
      .execute();
  }

  async getChainHead(): Promise<ChainHead | null> {
    const row = await this.requireDb()
      .selectFrom("chain_head")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirst();
    return row ? rowToChainHead(row) : null;
  }

  async upsertBabeEpoch(epoch: BabeEpochState): Promise<void> {
    const now = new Date().toISOString();
    await this.requireDb()
      .transaction()
      .execute(async (trx) => {
        await trx
          .updateTable("babe_epochs")
          .set({ is_current: false })
          .where("is_current", "=", true)
          .where("epoch_index", "!=", epoch.epochIndex)
          .execute();
        await trx
          .insertInto("babe_epochs")
          .values({
            epoch_index: epoch.epochIndex,
            current_slot: epoch.currentSlot,
            epoch_start_slot: epoch.epochStartSlot,
            slots_per_epoch: epoch.slotsPerEpoch,
            current_slot_in_epoch: epoch.currentSlotInEpoch,
            authority_count: epoch.authorityCount,
            is_current: true,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.column("epoch_index").doUpdateSet({
              current_slot: sql`excluded.current_slot`,
              epoch_start_slot: sql`excluded.epoch_start_slot`,
              slots_per_epoch: sql`excluded.slots_per_epoch`,
              current_slot_in_epoch: sql`excluded.current_slot_in_epoch`,
              authority_count: sql`excluded.authority_count`,
              is_current: true,
              updated_at: sql`excluded.updated_at`,
            }),
          )
          .execute();
      });
  }

  async getCurrentBabeEpoch(): Promise<BabeEpochState | null> {
    const row = await this.requireDb()
      .selectFrom("babe_epochs")
      .selectAll()
      .where("is_current", "=", true)
      .limit(1)
      .executeTakeFirst();
    return row ? rowToBabeEpoch(row) : null;
  }

  async upsertBabeAuthorities(
    epochIndex: number,
    authorities: BabeAuthorityRecord[],
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.requireDb()
      .transaction()
      .execute(async (trx) => {
        const incoming = authorities.map((a) => a.accountId);
        let demote = trx
          .updateTable("babe_authorities")
          .set({ is_active: false, updated_at: now })
          .where("epoch_index", "=", epochIndex)
          .where("is_active", "=", true);
        if (incoming.length > 0) demote = demote.where("account_id", "not in", incoming);
        await demote.execute();
        if (authorities.length === 0) return;
        for (const batch of chunkForParams(authorities, 5)) {
          await trx
            .insertInto("babe_authorities")
            .values(
              batch.map((a) => ({
                account_id: a.accountId,
                epoch_index: epochIndex,
                display_name: a.displayName,
                is_active: true,
                updated_at: now,
              })),
            )
            .onConflict((oc) =>
              oc.columns(["account_id", "epoch_index"]).doUpdateSet({
                display_name: sql`excluded.display_name`,
                is_active: true,
                updated_at: sql`excluded.updated_at`,
              }),
            )
            .execute();
        }
      });
  }

  async getActiveBabeAuthorities(): Promise<BabeAuthorityRecord[]> {
    const rows = await this.requireDb()
      .selectFrom("babe_authorities")
      .select(["account_id", "display_name"])
      .where("epoch_index", "=", (eb) =>
        eb.selectFrom("babe_epochs").select("epoch_index").where("is_current", "=", true).limit(1),
      )
      .where("is_active", "=", true)
      .orderBy("account_id")
      .execute();
    return rows.map((r) => ({ accountId: r.account_id, displayName: r.display_name }));
  }

  async upsertChainMiners(miners: ChainMinerLite[]): Promise<void> {
    if (miners.length === 0) return;
    const distinct = this.distinctOp();
    const now = new Date().toISOString();
    // chain_miners grows with the network, so a single multi-row INSERT can
    // exceed Postgres' bind-parameter ceiling. Chunk by column count (6/row);
    // the transaction keeps the whole set's update atomic across chunks.
    await this.requireDb()
      .transaction()
      .execute(async (trx) => {
        for (const batch of chunkForParams(miners, 6)) {
          await trx
            .insertInto("chain_miners")
            .values(
              batch.map((m) => ({
                account_id: m.accountId,
                deposit: m.deposit,
                proofs_submitted: m.proofsSubmitted,
                proofs_won: m.proofsWon,
                rewards_earned: m.rewardsEarned,
                updated_at: now,
              })),
            )
            .onConflict((oc) =>
              oc
                .column("account_id")
                .doUpdateSet({
                  deposit: sql`excluded.deposit`,
                  proofs_submitted: sql`excluded.proofs_submitted`,
                  proofs_won: sql`excluded.proofs_won`,
                  rewards_earned: sql`excluded.rewards_earned`,
                  updated_at: sql`excluded.updated_at`,
                })
                .where(
                  sql<boolean>`
                    chain_miners.deposit ${distinct} excluded.deposit or
                    chain_miners.proofs_submitted ${distinct} excluded.proofs_submitted or
                    chain_miners.proofs_won ${distinct} excluded.proofs_won or
                    chain_miners.rewards_earned ${distinct} excluded.rewards_earned
                  `,
                ),
            )
            .execute();
        }
      });
  }

  async getChainMiners(): Promise<ChainMinerLite[]> {
    const rows = await this.requireDb()
      .selectFrom("chain_miners")
      .selectAll()
      .orderBy("rewards_earned", "desc")
      .execute();
    return rows.map(rowToChainMiner);
  }

  async insertDifficultySnapshot(snapshot: DifficultyRecord): Promise<void> {
    await this.requireDb()
      .insertInto("difficulty_history")
      .values({
        observed_at_block: snapshot.observedAtBlock,
        difficulty_energy: snapshot.difficultyEnergy,
        min_diversity: snapshot.minDiversity,
        min_solutions: snapshot.minSolutions,
        observed_at: snapshot.observedAt,
        topology_hash: snapshot.topologyHash,
      })
      .onConflict((oc) => oc.column("observed_at_block").doNothing())
      .execute();
  }

  async getRecentDifficulty(limit: number): Promise<DifficultyRecord[]> {
    const rows = await this.requireDb()
      .selectFrom("difficulty_history")
      .selectAll()
      .orderBy("observed_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(rowToDifficulty);
  }

  // --- Mineable topologies (current-state snapshot in `meta`) ---

  async setMineableTopologies(records: MineableTopologyRecord[]): Promise<void> {
    await this.setMeta(MINEABLE_TOPOLOGIES_KEY, JSON.stringify(records));
  }

  async getMineableTopologies(): Promise<MineableTopologyRecord[]> {
    const raw = await this.getMeta(MINEABLE_TOPOLOGIES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MineableTopologyRecord[]) : [];
    } catch {
      return [];
    }
  }

  // --- Miner hardware ---

  async upsertMinerHardware(record: MinerHardwareRecord): Promise<void> {
    await this.requireDb()
      .insertInto("miner_hardware")
      .values({
        account_id: record.accountId,
        node_id: record.nodeId,
        miners: this.jsonVal(record.miners),
        primary_type: record.primaryType,
        source: record.source,
        observed_at: record.observedAt,
      })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          node_id: sql`excluded.node_id`,
          miners: sql`excluded.miners`,
          primary_type: sql`excluded.primary_type`,
          source: sql`excluded.source`,
          observed_at: sql`excluded.observed_at`,
        }),
      )
      .execute();
  }

  async getMinerHardware(accountId: string): Promise<MinerHardwareRecord | null> {
    const row = await this.requireDb()
      .selectFrom("miner_hardware")
      .selectAll()
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row ? rowToMinerHardware(row) : null;
  }

  async getAllMinerHardware(): Promise<MinerHardwareRecord[]> {
    const rows = await this.requireDb()
      .selectFrom("miner_hardware")
      .selectAll()
      .orderBy("observed_at", "desc")
      .execute();
    return rows.map(rowToMinerHardware);
  }

  // --- Validator authorship ---

  async recordValidatorAuthorship(
    accountId: string,
    blockNumber: string,
    blockTimestamp: number,
    hasPow: boolean,
  ): Promise<void> {
    const powDelta = hasPow ? 1 : 0;
    const lastAuthoredAt = new Date(blockTimestamp * 1000).toISOString();
    await this.requireDb()
      .insertInto("validator_authorship")
      .values({
        account_id: accountId,
        blocks_authored: 1,
        blocks_authored_with_pow: powDelta,
        last_authored_block: blockNumber,
        last_authored_at: lastAuthoredAt,
      })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          blocks_authored: sql`validator_authorship.blocks_authored + 1`,
          blocks_authored_with_pow: sql`validator_authorship.blocks_authored_with_pow + ${powDelta}`,
          last_authored_block: sql`excluded.last_authored_block`,
          last_authored_at: sql`excluded.last_authored_at`,
        }),
      )
      .execute();
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
    const rows = await this.requireDb()
      .selectFrom("validator_authorship")
      .selectAll()
      .orderBy("blocks_authored", "desc")
      .execute();
    return rows.map(rowToValidatorAuthorship);
  }

  // --- Node descriptors ---

  async upsertNodeDescriptor(record: NodeDescriptorRecord): Promise<void> {
    const lt = sql<boolean>`(node_descriptors.block_number, node_descriptors.extrinsic_index) < (excluded.block_number, excluded.extrinsic_index)`;
    await this.requireDb()
      .insertInto("node_descriptors")
      .values({
        account_id: record.accountId,
        block_number: record.blockNumber,
        block_hash: record.blockHash,
        extrinsic_index: record.extrinsicIndex,
        block_timestamp: record.blockTimestamp,
        first_block_timestamp: record.blockTimestamp,
        descriptor: this.jsonVal(record.descriptor),
        observed_at: record.observedAt,
      })
      .onConflict((oc) =>
        oc
          .column("account_id")
          .doUpdateSet({
            block_number: sql`excluded.block_number`,
            block_hash: sql`excluded.block_hash`,
            extrinsic_index: sql`excluded.extrinsic_index`,
            block_timestamp: sql`excluded.block_timestamp`,
            descriptor: sql`excluded.descriptor`,
            observed_at: sql`excluded.observed_at`,
          })
          .where(lt),
      )
      .execute();
  }

  async getAllNodeDescriptors(): Promise<NodeDescriptorRecord[]> {
    const order = sql`coalesce(descriptor->>'nodeName', account_id)`;
    const rows = await this.requireDb()
      .selectFrom("node_descriptors")
      .selectAll()
      .orderBy(order)
      .execute();
    return rows.map(rowToNodeDescriptor);
  }

  async getNodeDescriptor(accountId: string): Promise<NodeDescriptorRecord | null> {
    const row = await this.requireDb()
      .selectFrom("node_descriptors")
      .selectAll()
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row ? rowToNodeDescriptor(row) : null;
  }

  async backfillNodeDescriptorFirstSeen(
    accountId: string,
    firstBlockTimestamp: number,
  ): Promise<void> {
    await this.requireDb()
      .updateTable("node_descriptors")
      .set({
        first_block_timestamp: sql`least(node_descriptors.first_block_timestamp, ${firstBlockTimestamp})`,
      })
      .where("account_id", "=", accountId)
      .execute();
  }

  async getDescriptorCheckpoint(): Promise<string | null> {
    return this.getMeta(DESCRIPTOR_CHECKPOINT_KEY);
  }

  async setDescriptorCheckpoint(blockNumber: string): Promise<void> {
    await this.setMetaMonotonic(DESCRIPTOR_CHECKPOINT_KEY, blockNumber);
  }

  // --- Mining submissions ---

  async insertMiningSubmission(record: MiningSubmissionRecord): Promise<void> {
    await this.requireDb()
      .insertInto("mining_submissions")
      .values({
        miner_id: record.minerId,
        solution_number: record.solutionNumber,
        ts_ns: record.tsNs,
        energy_milli: record.energyMilli,
        diversity_milli: record.diversityMilli,
        threshold_milli: record.thresholdMilli,
        last_proof_block_hash: record.lastProofBlockHash,
        extrinsic_hash: record.extrinsicHash,
        chain_block_hash: record.chainBlockHash,
        chain_block_number: record.chainBlockNumber,
        pow_sequence: record.powSequence,
        outcome: record.outcome,
        attempt_count: record.attemptCount,
        best_energy_milli: record.bestEnergyMilli,
        num_valid: record.numValid,
        miner_type: record.minerType,
        qpu_access_time_us: record.qpuAccessTimeUs,
        observed_at: record.observedAt,
      })
      .onConflict((oc) =>
        oc.columns(["miner_id", "solution_number"]).doUpdateSet({
          ts_ns: sql`excluded.ts_ns`,
          energy_milli: sql`excluded.energy_milli`,
          diversity_milli: sql`excluded.diversity_milli`,
          threshold_milli: sql`excluded.threshold_milli`,
          last_proof_block_hash: sql`excluded.last_proof_block_hash`,
          extrinsic_hash: sql`excluded.extrinsic_hash`,
          chain_block_hash: sql`excluded.chain_block_hash`,
          chain_block_number: sql`excluded.chain_block_number`,
          pow_sequence: sql`excluded.pow_sequence`,
          outcome: sql`excluded.outcome`,
          attempt_count: sql`excluded.attempt_count`,
          best_energy_milli: sql`excluded.best_energy_milli`,
          num_valid: sql`excluded.num_valid`,
          miner_type: sql`excluded.miner_type`,
          qpu_access_time_us: sql`excluded.qpu_access_time_us`,
          observed_at: sql`excluded.observed_at`,
        }),
      )
      .execute();
  }

  async getRecentMiningSubmissions(
    minerId: string,
    limit: number,
  ): Promise<MiningSubmissionRecord[]> {
    const rows = await this.requireDb()
      .selectFrom("mining_submissions")
      .selectAll()
      .where("miner_id", "=", minerId)
      .orderBy("solution_number", "desc")
      .limit(limit)
      .execute();
    return rows.map(rowToMiningSubmission);
  }

  async countMiningSubmissionsWithAttempts(minerId: string): Promise<number> {
    const row = await this.requireDb()
      .selectFrom("mining_submissions")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("miner_id", "=", minerId)
      .where("attempt_count", ">", 0)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async getMiningCheckpoint(minerId: string): Promise<number | null> {
    const raw = await this.getMeta(miningCheckpointKey(minerId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async setMiningCheckpoint(minerId: string, solutionNumber: number): Promise<void> {
    await this.setMetaMonotonic(miningCheckpointKey(minerId), String(solutionNumber));
  }

  async resetMiningHistory(minerId: string): Promise<void> {
    const db = this.requireDb();
    await db.deleteFrom("mining_submissions").where("miner_id", "=", minerId).execute();
    await db.deleteFrom("meta").where("key", "=", miningCheckpointKey(minerId)).execute();
  }

  // --- internals ---

  private async getMeta(key: string): Promise<string | null> {
    const row = await this.requireDb()
      .selectFrom("meta")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  private async setMeta(key: string, value: string | null): Promise<void> {
    await this.requireDb()
      .insertInto("meta")
      .values({ key, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: sql`excluded.value` }))
      .execute();
  }

  private async setMetaMonotonic(key: string, value: string): Promise<void> {
    await this.requireDb()
      .insertInto("meta")
      .values({ key, value })
      .onConflict((oc) =>
        oc
          .column("key")
          .doUpdateSet({ value: sql`excluded.value` })
          .where(sql<boolean>`cast(meta.value as numeric) < cast(excluded.value as numeric)`),
      )
      .execute();
  }

  private jsonVal(v: unknown): RawBuilder<unknown> {
    return sql`${JSON.stringify(v)}::jsonb`;
  }

  private distinctOp(): RawBuilder<unknown> {
    return sql.raw("is distinct from");
  }

  private requireDb(): Kysely<DB> {
    if (!this.db) {
      throw new Error("KyselyAdapter not connected. Call connect() first.");
    }
    return this.db;
  }

  private migratorDb(): Kysely<unknown> {
    return this.requireDb() as unknown as Kysely<unknown>;
  }
}
