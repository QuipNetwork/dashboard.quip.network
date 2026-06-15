// SPDX-License-Identifier: AGPL-3.0-or-later

import { Kysely } from "kysely";
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
  MinerCategory,
  MinerHardwareRecord,
  MiningSubmissionRecord,
  NodeDescriptor,
  NodeDescriptorRecord,
} from "../../src/types/telemetry";
import { parseIndexerObservability, type DatabaseAdapter, type DbConfig } from "./adapter";
import {
  migrateToLatest,
  migrationStatus,
  pendingMigrations,
  type MigrationStatusRow,
} from "./migrator";

const DESCRIPTOR_CHECKPOINT_KEY = "descriptor_checkpoint";

const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";

const MINING_CHECKPOINT_KEY_PREFIX = "mining_checkpoint:";

function miningCheckpointKey(minerId: string): string {
  return `${MINING_CHECKPOINT_KEY_PREFIX}${minerId}`;
}

export class PostgresAdapter implements DatabaseAdapter {
  private sql: Sql | null = null;
  private readonly url: string;

  constructor(config: DbConfig) {
    const url = config.databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error("postgres adapter requires DATABASE_URL or config.databaseUrl");
    }
    this.url = url;
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

  private kysely(): Kysely<unknown> {
    return new Kysely<unknown>({
      dialect: new PostgresJSDialect({ postgres: this.requireSql() }),
    });
  }

  async migrate(): Promise<void> {
    await migrateToLatest(this.kysely(), "postgres");
  }

  async migrationStatus(): Promise<MigrationStatusRow[]> {
    return migrationStatus(this.kysely(), "postgres");
  }

  async pendingMigrations(): Promise<string[]> {
    return pendingMigrations(this.kysely(), "postgres");
  }

  // --- Blocks ---

  async insertBlock(b: BlockRecord): Promise<void> {
    // ON CONFLICT DO NOTHING: the substrate worker is the sole writer; a PK
    // collision on block_hash is a programmatic duplicate (e.g., the same
    // head emitted twice), not a normal flow — silently skip.
    await this.requireSql()`
      INSERT INTO blocks (
        block_hash, substrate_block_number, substrate_block_hash, substrate_parent_hash,
        timestamp, miner_id,
        energy, diversity, num_valid_solutions, mining_time,
        reward, nonce, num_nodes, num_edges,
        difficulty_energy, min_diversity, min_solutions, finalized
      ) VALUES (
        ${b.blockHash}, ${b.substrateBlockNumber}, ${b.substrateBlockHash}, ${b.substrateParentHash},
        ${b.timestamp}, ${b.minerId},
        ${b.energy}, ${b.diversity}, ${b.numValidSolutions}, ${b.miningTime},
        ${b.reward}, ${b.nonce}, ${b.numNodes}, ${b.numEdges},
        ${b.difficultyEnergy}, ${b.minDiversity}, ${b.minSolutions}, ${b.finalized}
      )
      ON CONFLICT (block_hash) DO NOTHING
    `;
  }

  async getRecentBlocks(limit: number, offset: number = 0): Promise<BlockRecord[]> {
    const rows = await this.requireSql()<Record<string, unknown>[]>`
      SELECT * FROM blocks
      ORDER BY substrate_block_number DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(rowToBlockRecord);
  }

  async getBlocksByMiner(minerId: string, limit: number): Promise<BlockRecord[]> {
    const rows = await this.requireSql()<Record<string, unknown>[]>`
      SELECT * FROM blocks
      WHERE miner_id = ${minerId}
      ORDER BY substrate_block_number DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToBlockRecord);
  }

  async markBlockFinalized(blockHash: string): Promise<void> {
    // Monotonic: only flip false → true. Idempotent — already-finalized rows
    // and unknown hashes both become no-ops by the WHERE clause.
    await this.requireSql()`
      UPDATE blocks SET finalized = TRUE
      WHERE block_hash = ${blockHash} AND finalized = FALSE
    `;
  }

  // --- Self-identity ---

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

  // --- Indexer observability ---

  async getIndexerObservability(): Promise<IndexerObservability | null> {
    const rows = await this.requireSql()<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = ${INDEXER_OBSERVABILITY_KEY}
    `;
    const raw = rows[0]?.value;
    if (!raw) return null;
    return parseIndexerObservability(raw, "postgres");
  }

  async setIndexerObservability(obs: IndexerObservability): Promise<void> {
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${INDEXER_OBSERVABILITY_KEY}, ${JSON.stringify(obs)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  /** @internal test-only — write a raw value under a meta key. */
  async setMetaRaw(key: string, value: string): Promise<void> {
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  // --- Substrate-derived state (unchanged from v5) ---

  async upsertChainHead(head: ChainHead): Promise<void> {
    await this.requireSql()`
      INSERT INTO chain_head (
        id, best_block_number, best_block_hash,
        finalized_block_number, finalized_block_hash, finality_lag,
        winning_solutions_count,
        spec_name, spec_version, transaction_version, impl_name,
        last_runtime_upgrade, updated_at
      ) VALUES (
        1, ${head.bestBlockNumber}, ${head.bestBlockHash},
        ${head.finalizedBlockNumber}, ${head.finalizedBlockHash}, ${head.finalityLag},
        ${head.winningSolutionsCount},
        ${head.runtime.specName}, ${head.runtime.specVersion}, ${head.runtime.transactionVersion},
        ${head.runtime.implName}, ${head.runtime.lastRuntimeUpgrade}, ${head.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        best_block_number = EXCLUDED.best_block_number,
        best_block_hash = EXCLUDED.best_block_hash,
        finalized_block_number = EXCLUDED.finalized_block_number,
        finalized_block_hash = EXCLUDED.finalized_block_hash,
        finality_lag = EXCLUDED.finality_lag,
        winning_solutions_count = EXCLUDED.winning_solutions_count,
        spec_name = EXCLUDED.spec_name,
        spec_version = EXCLUDED.spec_version,
        transaction_version = EXCLUDED.transaction_version,
        impl_name = EXCLUDED.impl_name,
        last_runtime_upgrade = EXCLUDED.last_runtime_upgrade,
        updated_at = EXCLUDED.updated_at
      WHERE
        chain_head.best_block_number IS DISTINCT FROM EXCLUDED.best_block_number OR
        chain_head.finalized_block_number IS DISTINCT FROM EXCLUDED.finalized_block_number OR
        chain_head.winning_solutions_count IS DISTINCT FROM EXCLUDED.winning_solutions_count OR
        chain_head.spec_version IS DISTINCT FROM EXCLUDED.spec_version
    `;
  }

  async getChainHead(): Promise<ChainHead | null> {
    const rows = await this.requireSql()<
      {
        best_block_number: string;
        best_block_hash: string;
        finalized_block_number: string;
        finalized_block_hash: string;
        finality_lag: number;
        winning_solutions_count: string | null;
        spec_name: string;
        spec_version: number;
        transaction_version: number;
        impl_name: string;
        last_runtime_upgrade: string | null;
        updated_at: Date;
      }[]
    >`SELECT * FROM chain_head WHERE id = 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      bestBlockNumber: row.best_block_number,
      bestBlockHash: row.best_block_hash,
      finalizedBlockNumber: row.finalized_block_number,
      finalizedBlockHash: row.finalized_block_hash,
      finalityLag: row.finality_lag,
      winningSolutionsCount:
        row.winning_solutions_count === null ? null : Number(row.winning_solutions_count),
      runtime: {
        specName: row.spec_name,
        specVersion: row.spec_version,
        transactionVersion: row.transaction_version,
        implName: row.impl_name,
        lastRuntimeUpgrade: row.last_runtime_upgrade,
      },
      // TIMESTAMPTZ comes back as Date; serialize for downstream comparison.
      updatedAt:
        row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async upsertBabeEpoch(epoch: BabeEpochState): Promise<void> {
    const sql = this.requireSql();
    const now = new Date().toISOString();
    await sql.begin(async (tx) => {
      await tx`UPDATE babe_epochs SET is_current = FALSE WHERE is_current AND epoch_index <> ${epoch.epochIndex}`;
      await tx`
        INSERT INTO babe_epochs (
          epoch_index, current_slot, epoch_start_slot,
          slots_per_epoch, current_slot_in_epoch, authority_count,
          is_current, updated_at
        ) VALUES (
          ${epoch.epochIndex}, ${epoch.currentSlot}, ${epoch.epochStartSlot},
          ${epoch.slotsPerEpoch}, ${epoch.currentSlotInEpoch}, ${epoch.authorityCount},
          TRUE, ${now}
        )
        ON CONFLICT (epoch_index) DO UPDATE SET
          current_slot = EXCLUDED.current_slot,
          epoch_start_slot = EXCLUDED.epoch_start_slot,
          slots_per_epoch = EXCLUDED.slots_per_epoch,
          current_slot_in_epoch = EXCLUDED.current_slot_in_epoch,
          authority_count = EXCLUDED.authority_count,
          is_current = TRUE,
          updated_at = EXCLUDED.updated_at
      `;
    });
  }

  async getCurrentBabeEpoch(): Promise<BabeEpochState | null> {
    const rows = await this.requireSql()<
      {
        epoch_index: number;
        current_slot: string;
        epoch_start_slot: string;
        slots_per_epoch: number;
        current_slot_in_epoch: number;
        authority_count: number;
      }[]
    >`SELECT * FROM babe_epochs WHERE is_current LIMIT 1`;
    const row = rows[0];
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
    const sql = this.requireSql();
    const now = new Date().toISOString();
    await sql.begin(async (tx) => {
      const incoming = authorities.map((a) => a.accountId);
      // Demote authorities that fell out of the new set.
      if (incoming.length > 0) {
        await tx`
          UPDATE babe_authorities
          SET is_active = FALSE, updated_at = ${now}
          WHERE epoch_index = ${epochIndex}
            AND is_active = TRUE
            AND account_id NOT IN ${tx(incoming)}
        `;
      } else {
        await tx`
          UPDATE babe_authorities
          SET is_active = FALSE, updated_at = ${now}
          WHERE epoch_index = ${epochIndex} AND is_active = TRUE
        `;
      }
      for (const a of authorities) {
        await tx`
          INSERT INTO babe_authorities (account_id, epoch_index, display_name, is_active, updated_at)
          VALUES (${a.accountId}, ${epochIndex}, ${a.displayName}, TRUE, ${now})
          ON CONFLICT (account_id, epoch_index) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            is_active = TRUE,
            updated_at = EXCLUDED.updated_at
        `;
      }
    });
  }

  async getActiveBabeAuthorities(): Promise<BabeAuthorityRecord[]> {
    const rows = await this.requireSql()<{ account_id: string; display_name: string | null }[]>`
      SELECT account_id, display_name FROM babe_authorities
      WHERE epoch_index = (SELECT epoch_index FROM babe_epochs WHERE is_current LIMIT 1)
        AND is_active
      ORDER BY account_id
    `;
    return rows.map((r) => ({ accountId: r.account_id, displayName: r.display_name }));
  }

  async upsertChainMiners(
    miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">>,
  ): Promise<void> {
    const sql = this.requireSql();
    const now = new Date().toISOString();
    await sql.begin(async (tx) => {
      for (const m of miners) {
        await tx`
          INSERT INTO chain_miners (
            account_id, deposit, proofs_submitted, proofs_won, rewards_earned, updated_at
          ) VALUES (
            ${m.accountId}, ${m.deposit}, ${m.proofsSubmitted}, ${m.proofsWon}, ${m.rewardsEarned}, ${now}
          )
          ON CONFLICT (account_id) DO UPDATE SET
            deposit = EXCLUDED.deposit,
            proofs_submitted = EXCLUDED.proofs_submitted,
            proofs_won = EXCLUDED.proofs_won,
            rewards_earned = EXCLUDED.rewards_earned,
            updated_at = EXCLUDED.updated_at
          WHERE
            chain_miners.deposit IS DISTINCT FROM EXCLUDED.deposit OR
            chain_miners.proofs_submitted IS DISTINCT FROM EXCLUDED.proofs_submitted OR
            chain_miners.proofs_won IS DISTINCT FROM EXCLUDED.proofs_won OR
            chain_miners.rewards_earned IS DISTINCT FROM EXCLUDED.rewards_earned
        `;
      }
    });
  }

  async getChainMiners(): Promise<
    Array<Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">>
  > {
    const rows = await this.requireSql()<
      {
        account_id: string;
        deposit: string;
        proofs_submitted: string;
        proofs_won: string;
        rewards_earned: string;
      }[]
    >`SELECT * FROM chain_miners ORDER BY rewards_earned DESC`;
    return rows.map((r) => ({
      accountId: r.account_id,
      deposit: r.deposit,
      proofsSubmitted: r.proofs_submitted,
      proofsWon: r.proofs_won,
      rewardsEarned: r.rewards_earned,
    }));
  }

  async insertDifficultySnapshot(snapshot: DifficultyRecord): Promise<void> {
    await this.requireSql()`
      INSERT INTO difficulty_history
        (observed_at_block, difficulty_energy, min_diversity, min_solutions, observed_at)
      VALUES (
        ${snapshot.observedAtBlock}, ${snapshot.difficultyEnergy},
        ${snapshot.minDiversity}, ${snapshot.minSolutions},
        ${snapshot.observedAt}
      )
      ON CONFLICT (observed_at_block) DO NOTHING
    `;
  }

  async getRecentDifficulty(limit: number): Promise<DifficultyRecord[]> {
    const rows = await this.requireSql()<
      {
        observed_at_block: string;
        difficulty_energy: number;
        min_diversity: number;
        min_solutions: number;
        observed_at: Date;
      }[]
    >`SELECT * FROM difficulty_history ORDER BY observed_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      observedAtBlock: r.observed_at_block,
      difficultyEnergy: r.difficulty_energy,
      minDiversity: r.min_diversity,
      minSolutions: r.min_solutions,
      observedAt:
        r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at),
    }));
  }

  // --- Miner hardware ---

  async upsertMinerHardware(record: MinerHardwareRecord): Promise<void> {
    // Pass `miners` as a JSON string so postgres-js sends a plain text body
    // the driver can cast into JSONB. Mirrors the SQLite TEXT-column shape
    // and keeps the contract identical at the adapter boundary.
    await this.requireSql()`
      INSERT INTO miner_hardware (account_id, node_id, miners, primary_type, source, observed_at)
      VALUES (
        ${record.accountId}, ${record.nodeId}, ${JSON.stringify(record.miners)}::jsonb,
        ${record.primaryType}, ${record.source}, ${record.observedAt}
      )
      ON CONFLICT (account_id) DO UPDATE SET
        node_id      = EXCLUDED.node_id,
        miners       = EXCLUDED.miners,
        primary_type = EXCLUDED.primary_type,
        source       = EXCLUDED.source,
        observed_at  = EXCLUDED.observed_at
    `;
  }

  async getMinerHardware(accountId: string): Promise<MinerHardwareRecord | null> {
    const rows = await this.requireSql()<Record<string, unknown>[]>`
      SELECT * FROM miner_hardware WHERE account_id = ${accountId}
    `;
    const row = rows[0];
    if (!row) return null;
    return rowToMinerHardware(row);
  }

  async getAllMinerHardware(): Promise<MinerHardwareRecord[]> {
    const rows = await this.requireSql()<Record<string, unknown>[]>`
      SELECT * FROM miner_hardware ORDER BY observed_at DESC
    `;
    return rows.map(rowToMinerHardware);
  }

  // --- Validator authorship (v7) ---

  async recordValidatorAuthorship(
    accountId: string,
    blockNumber: string,
    blockTimestamp: number,
    hasPow: boolean,
  ): Promise<void> {
    // unix-seconds → ISO 8601 at the adapter boundary; the TIMESTAMPTZ
    // column accepts ISO strings without explicit casts. PoW counter
    // increments by 0 or 1 keyed on `hasPow`.
    const powDelta = hasPow ? 1 : 0;
    const lastAuthoredAt = new Date(blockTimestamp * 1000).toISOString();
    await this.requireSql()`
      INSERT INTO validator_authorship (
        account_id, blocks_authored, blocks_authored_with_pow,
        last_authored_block, last_authored_at
      ) VALUES (
        ${accountId}, 1, ${powDelta}, ${blockNumber}, ${lastAuthoredAt}
      )
      ON CONFLICT (account_id) DO UPDATE SET
        blocks_authored = validator_authorship.blocks_authored + 1,
        blocks_authored_with_pow =
          validator_authorship.blocks_authored_with_pow + ${powDelta},
        last_authored_block = EXCLUDED.last_authored_block,
        last_authored_at = EXCLUDED.last_authored_at
    `;
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
    const rows = await this.requireSql()<
      {
        account_id: string;
        // BIGINT comes back as string from postgres-js by default.
        blocks_authored: string;
        blocks_authored_with_pow: string;
        last_authored_block: string;
        last_authored_at: Date;
      }[]
    >`SELECT * FROM validator_authorship ORDER BY blocks_authored DESC`;
    return rows.map((r) => ({
      accountId: r.account_id,
      blocksAuthored: Number(r.blocks_authored),
      blocksAuthoredWithPow: Number(r.blocks_authored_with_pow),
      lastAuthoredBlock: r.last_authored_block,
      lastAuthoredAt:
        r.last_authored_at instanceof Date
          ? r.last_authored_at.toISOString()
          : String(r.last_authored_at),
    }));
  }

  // --- Node descriptors (v11) ---

  async upsertNodeDescriptor(record: NodeDescriptorRecord): Promise<void> {
    // Tuple ordering — newer block, or same block + later extrinsic, wins.
    // NUMERIC vs INTEGER tuple comparison Just Works in postgres.
    // first_block_timestamp is excluded from the UPDATE SET so the original
    // first-observed value sticks; every other column moves to the new row.
    await this.requireSql()`
      INSERT INTO node_descriptors (
        account_id, block_number, block_hash, extrinsic_index,
        block_timestamp, first_block_timestamp, descriptor, observed_at
      ) VALUES (
        ${record.accountId}, ${record.blockNumber}, ${record.blockHash}, ${record.extrinsicIndex},
        ${record.blockTimestamp}, ${record.blockTimestamp},
        ${JSON.stringify(record.descriptor)}::jsonb, ${record.observedAt}
      )
      ON CONFLICT (account_id) DO UPDATE SET
        block_number     = EXCLUDED.block_number,
        block_hash       = EXCLUDED.block_hash,
        extrinsic_index  = EXCLUDED.extrinsic_index,
        block_timestamp  = EXCLUDED.block_timestamp,
        descriptor       = EXCLUDED.descriptor,
        observed_at      = EXCLUDED.observed_at
      WHERE
        (node_descriptors.block_number, node_descriptors.extrinsic_index)
          < (EXCLUDED.block_number, EXCLUDED.extrinsic_index)
    `;
  }

  async getAllNodeDescriptors(): Promise<NodeDescriptorRecord[]> {
    const rows = await this.requireSql()<
      {
        account_id: string;
        block_number: string;
        block_hash: string;
        extrinsic_index: number;
        block_timestamp: string;
        first_block_timestamp: string;
        descriptor: unknown;
        observed_at: Date;
      }[]
    >`
      SELECT * FROM node_descriptors
      ORDER BY COALESCE(descriptor->>'nodeName', account_id)
    `;
    return rows.map(rowToNodeDescriptorRecord);
  }

  async getNodeDescriptor(accountId: string): Promise<NodeDescriptorRecord | null> {
    const rows = await this.requireSql()<
      {
        account_id: string;
        block_number: string;
        block_hash: string;
        extrinsic_index: number;
        block_timestamp: string;
        first_block_timestamp: string;
        descriptor: unknown;
        observed_at: Date;
      }[]
    >`
      SELECT * FROM node_descriptors WHERE account_id = ${accountId}
    `;
    return rows[0] ? rowToNodeDescriptorRecord(rows[0]) : null;
  }

  async getDescriptorCheckpoint(): Promise<string | null> {
    const rows = await this.requireSql()<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = ${DESCRIPTOR_CHECKPOINT_KEY}
    `;
    return rows[0]?.value ?? null;
  }

  async setDescriptorCheckpoint(blockNumber: string): Promise<void> {
    // Monotonic advance only. NUMERIC cast keeps the comparison numeric
    // when the stored value is a TEXT u64.
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${DESCRIPTOR_CHECKPOINT_KEY}, ${blockNumber})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      WHERE CAST(meta.value AS NUMERIC) < CAST(EXCLUDED.value AS NUMERIC)
    `;
  }

  async insertMiningSubmission(record: MiningSubmissionRecord): Promise<void> {
    // UPSERT — refresh all non-PK columns including observed_at (acts as
    // "last fetched at"). chain_block_* may flip from null → populated
    // when the indexer re-fetches a previously-pending submission.
    await this.requireSql()`
      INSERT INTO mining_submissions (
        miner_id, solution_number, ts_ns,
        energy_milli, diversity_milli, threshold_milli,
        last_proof_block_hash, extrinsic_hash, chain_block_hash, chain_block_number,
        pow_sequence, outcome, attempt_count, best_energy_milli, num_valid, miner_type,
        qpu_access_time_us, observed_at
      ) VALUES (
        ${record.minerId}, ${record.solutionNumber}, ${record.tsNs},
        ${record.energyMilli}, ${record.diversityMilli}, ${record.thresholdMilli},
        ${record.lastProofBlockHash}, ${record.extrinsicHash},
        ${record.chainBlockHash}, ${record.chainBlockNumber},
        ${record.powSequence},
        ${record.outcome}, ${record.attemptCount}, ${record.bestEnergyMilli},
        ${record.numValid}, ${record.minerType},
        ${record.qpuAccessTimeUs}, ${record.observedAt}
      )
      ON CONFLICT (miner_id, solution_number) DO UPDATE SET
        ts_ns                          = EXCLUDED.ts_ns,
        energy_milli                   = EXCLUDED.energy_milli,
        diversity_milli                = EXCLUDED.diversity_milli,
        threshold_milli                = EXCLUDED.threshold_milli,
        last_proof_block_hash          = EXCLUDED.last_proof_block_hash,
        extrinsic_hash                 = EXCLUDED.extrinsic_hash,
        chain_block_hash               = EXCLUDED.chain_block_hash,
        chain_block_number             = EXCLUDED.chain_block_number,
        pow_sequence                   = EXCLUDED.pow_sequence,
        outcome                        = EXCLUDED.outcome,
        attempt_count                  = EXCLUDED.attempt_count,
        best_energy_milli              = EXCLUDED.best_energy_milli,
        num_valid                      = EXCLUDED.num_valid,
        miner_type                     = EXCLUDED.miner_type,
        qpu_access_time_us             = EXCLUDED.qpu_access_time_us,
        observed_at                    = EXCLUDED.observed_at
    `;
  }

  async getRecentMiningSubmissions(
    minerId: string,
    limit: number,
  ): Promise<MiningSubmissionRecord[]> {
    const rows = await this.requireSql()<
      {
        miner_id: string;
        // BIGINT/NUMERIC columns come back as strings from postgres-js to
        // preserve precision; convert at the adapter boundary.
        solution_number: string;
        ts_ns: string;
        energy_milli: string;
        diversity_milli: string;
        threshold_milli: string;
        last_proof_block_hash: string;
        extrinsic_hash: string | null;
        chain_block_hash: string | null;
        chain_block_number: string | null;
        pow_sequence: string | null;
        outcome: string;
        attempt_count: number;
        best_energy_milli: string;
        num_valid: number;
        miner_type: string;
        qpu_access_time_us: string;
        observed_at: Date;
      }[]
    >`
      SELECT * FROM mining_submissions
      WHERE miner_id = ${minerId}
      ORDER BY solution_number DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      minerId: r.miner_id,
      solutionNumber: Number(r.solution_number),
      tsNs: String(r.ts_ns),
      energyMilli: Number(r.energy_milli),
      diversityMilli: Number(r.diversity_milli),
      thresholdMilli: Number(r.threshold_milli),
      lastProofBlockHash: r.last_proof_block_hash,
      extrinsicHash: r.extrinsic_hash,
      chainBlockHash: r.chain_block_hash,
      chainBlockNumber: r.chain_block_number === null ? null : String(r.chain_block_number),
      powSequence: r.pow_sequence === null ? null : Number(r.pow_sequence),
      outcome: r.outcome,
      attemptCount: r.attempt_count,
      bestEnergyMilli: Number(r.best_energy_milli),
      numValid: r.num_valid,
      minerType: r.miner_type ?? "",
      qpuAccessTimeUs: Number(r.qpu_access_time_us ?? 0),
      observedAt:
        r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at),
    }));
  }

  async countMiningSubmissionsWithAttempts(minerId: string): Promise<number> {
    const rows = await this.requireSql()<{ n: string }[]>`
      SELECT COUNT(*)::bigint AS n FROM mining_submissions
      WHERE miner_id = ${minerId} AND attempt_count > 0
    `;
    return Number(rows[0]?.n ?? 0);
  }

  async getMiningCheckpoint(minerId: string): Promise<number | null> {
    const rows = await this.requireSql()<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = ${miningCheckpointKey(minerId)}
    `;
    const raw = rows[0]?.value;
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async setMiningCheckpoint(minerId: string, solutionNumber: number): Promise<void> {
    // Monotonic advance only — parallels setDescriptorCheckpoint.
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${miningCheckpointKey(minerId)}, ${String(solutionNumber)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      WHERE CAST(meta.value AS NUMERIC) < CAST(EXCLUDED.value AS NUMERIC)
    `;
  }

  async resetMiningHistory(minerId: string): Promise<void> {
    const sql = this.requireSql();
    await sql`DELETE FROM mining_submissions WHERE miner_id = ${minerId}`;
    await sql`DELETE FROM meta WHERE key = ${miningCheckpointKey(minerId)}`;
  }

  private requireSql(): Sql {
    if (!this.sql) {
      throw new Error("PostgresAdapter not connected. Call connect() first.");
    }
    return this.sql;
  }
}

function rowToBlockRecord(row: Record<string, unknown>): BlockRecord {
  return {
    blockHash: String(row.block_hash),
    // NUMERIC columns come back as strings from postgres-js to preserve
    // arbitrary precision — direct String() keeps the u64/u128 contract.
    substrateBlockNumber: String(row.substrate_block_number),
    substrateBlockHash: String(row.substrate_block_hash),
    substrateParentHash: String(row.substrate_parent_hash),
    // BIGINT also returns as string; Number() is safe — unix seconds fit
    // comfortably inside MAX_SAFE_INTEGER.
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
    finalized: Boolean(row.finalized),
  };
}

function rowToNodeDescriptorRecord(row: {
  account_id: string;
  block_number: string;
  block_hash: string;
  extrinsic_index: number;
  block_timestamp: string;
  first_block_timestamp: string;
  descriptor: unknown;
  observed_at: Date | string;
}): NodeDescriptorRecord {
  // JSONB comes back as a parsed object from postgres-js; defensively parse
  // a TEXT fallback for legacy rows.
  const descriptor =
    typeof row.descriptor === "string"
      ? (JSON.parse(row.descriptor) as NodeDescriptor)
      : (row.descriptor as NodeDescriptor);
  return {
    accountId: row.account_id,
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    extrinsicIndex: row.extrinsic_index,
    // BIGINT comes back as string; convert at the boundary.
    blockTimestamp: Number(row.block_timestamp),
    firstBlockTimestamp: Number(row.first_block_timestamp),
    descriptor,
    observedAt:
      row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at),
  };
}

function rowToMinerHardware(row: Record<string, unknown>): MinerHardwareRecord {
  // postgres-js returns JSONB as a JSON-string on plain `SELECT *` (no
  // typed-row hint). Parse it here so callers get the structured array.
  // Stay defensive against a future driver change that hands back a parsed
  // object — only parse when the raw value is a string.
  const rawMiners = row.miners;
  const miners = (typeof rawMiners === "string" ? JSON.parse(rawMiners) : rawMiners) as Array<{
    id: string;
    type: MinerCategory;
  }>;
  return {
    accountId: String(row.account_id),
    nodeId: String(row.node_id),
    miners,
    primaryType: String(row.primary_type) as MinerCategory,
    source: String(row.source) as MinerHardwareRecord["source"],
    // TIMESTAMPTZ comes back as Date; serialize to ISO for the type contract.
    observedAt:
      row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at),
  };
}
