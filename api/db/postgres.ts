// SPDX-License-Identifier: AGPL-3.0-or-later

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
  "DROP TABLE IF EXISTS epoch_status CASCADE",
  "DROP TABLE IF EXISTS nodes_snapshot CASCADE",
  "DROP TABLE IF EXISTS self_address CASCADE",
  "DROP TABLE IF EXISTS indexer_cursors CASCADE",
  "DROP TABLE IF EXISTS indexer_etags CASCADE",
];

const SCHEMA_STATEMENTS: string[] = [
  // Blocks: substrate worker is the sole writer in v6. Every column is
  // populated at insert time — no two-phase enrichment, no canonical flag.
  // NUMERIC stores arbitrary-precision integers natively, so unlike SQLite
  // we don't need CAST in the index — ORDER BY is already numeric. At the
  // adapter boundary we convert NUMERIC ↔ string for the BlockRecord type
  // to preserve u64/u128 precision.
  `CREATE TABLE IF NOT EXISTS blocks (
     block_hash              TEXT PRIMARY KEY,
     substrate_block_number  NUMERIC NOT NULL,
     substrate_block_hash    TEXT NOT NULL,
     substrate_parent_hash   TEXT NOT NULL,
     timestamp               BIGINT NOT NULL,
     miner_id                TEXT NOT NULL,
     energy                  DOUBLE PRECISION NOT NULL,
     diversity               DOUBLE PRECISION NOT NULL,
     num_valid_solutions     INTEGER NOT NULL,
     quality_milli           INTEGER NOT NULL,
     mining_time             DOUBLE PRECISION NOT NULL,
     reward                  NUMERIC NOT NULL,
     nonce                   NUMERIC NOT NULL,
     num_nodes               INTEGER NOT NULL,
     num_edges               INTEGER NOT NULL,
     difficulty_energy       DOUBLE PRECISION NOT NULL,
     min_diversity           DOUBLE PRECISION NOT NULL,
     min_solutions           INTEGER NOT NULL,
     finalized               BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_substrate_number
     ON blocks(substrate_block_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner_id
     ON blocks(miner_id, substrate_block_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC)`,
  // Per-miner hardware inventory. v0.3 only writes one row (source='self').
  // JSONB for `miners` so the array is queryable and indexable natively;
  // TIMESTAMPTZ for observed_at so DESC ordering is calendar-correct.
  `CREATE TABLE IF NOT EXISTS miner_hardware (
     account_id    TEXT PRIMARY KEY,
     node_id       TEXT NOT NULL,
     miners        JSONB NOT NULL,
     primary_type  TEXT NOT NULL,
     source        TEXT NOT NULL,
     observed_at   TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
  // v5 substrate-derived tables (unchanged from v5). NUMERIC for u64/u128;
  // BIGINT for fields that fit in 63 bits.
  `CREATE TABLE IF NOT EXISTS chain_head (
     id                      INTEGER PRIMARY KEY CHECK (id = 1),
     best_block_number       NUMERIC NOT NULL,
     best_block_hash         TEXT NOT NULL,
     finalized_block_number  NUMERIC NOT NULL,
     finalized_block_hash    TEXT NOT NULL,
     finality_lag            INTEGER NOT NULL,
     spec_name               TEXT NOT NULL,
     spec_version            INTEGER NOT NULL,
     transaction_version     INTEGER NOT NULL,
     impl_name               TEXT NOT NULL,
     last_runtime_upgrade    NUMERIC,
     updated_at              TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS babe_epochs (
     epoch_index             INTEGER PRIMARY KEY,
     current_slot            NUMERIC NOT NULL,
     epoch_start_slot        NUMERIC NOT NULL,
     slots_per_epoch         INTEGER NOT NULL,
     current_slot_in_epoch   INTEGER NOT NULL,
     authority_count         INTEGER NOT NULL,
     is_current              BOOLEAN NOT NULL DEFAULT FALSE,
     updated_at              TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_babe_epochs_current ON babe_epochs(is_current) WHERE is_current`,
  `CREATE TABLE IF NOT EXISTS babe_authorities (
     account_id    TEXT NOT NULL,
     epoch_index   INTEGER NOT NULL,
     display_name  TEXT,
     is_active     BOOLEAN NOT NULL DEFAULT FALSE,
     updated_at    TIMESTAMPTZ NOT NULL,
     PRIMARY KEY (account_id, epoch_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_babe_authorities_active
     ON babe_authorities(epoch_index, is_active)`,
  `CREATE TABLE IF NOT EXISTS chain_miners (
     account_id        TEXT PRIMARY KEY,
     deposit           NUMERIC NOT NULL,
     proofs_submitted  NUMERIC NOT NULL,
     proofs_won        NUMERIC NOT NULL,
     rewards_earned    NUMERIC NOT NULL,
     updated_at        TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS difficulty_history (
     observed_at_block  NUMERIC PRIMARY KEY,
     difficulty_energy  DOUBLE PRECISION NOT NULL,
     min_diversity      DOUBLE PRECISION NOT NULL,
     min_solutions      INTEGER NOT NULL,
     min_quality        DOUBLE PRECISION NOT NULL,
     observed_at        TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_difficulty_history_observed
     ON difficulty_history(observed_at DESC)`,
  // v7: per-validator authorship counters. BIGINT counters since long-
  // running validators easily exceed INTEGER range; TIMESTAMPTZ for
  // last_authored_at so DESC ordering is calendar-correct.
  `CREATE TABLE IF NOT EXISTS validator_authorship (
     account_id                 TEXT PRIMARY KEY,
     blocks_authored            BIGINT NOT NULL DEFAULT 0,
     blocks_authored_with_pow   BIGINT NOT NULL DEFAULT 0,
     last_authored_block        NUMERIC NOT NULL,
     last_authored_at           TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_validator_authorship_authored
     ON validator_authorship(blocks_authored DESC)`,
];

const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";

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

  async migrate(): Promise<void> {
    const sql = this.requireSql();
    // Drop v5/legacy tables before anything else. These were owned by workers
    // that no longer exist in v0.3 (epoch_status, nodes_snapshot, self_address,
    // indexer_cursors, indexer_etags). On a fresh database these are all
    // no-ops; on a v0.2 Postgres they clear the worker-state remnants.
    for (const stmt of LEGACY_DROP_STATEMENTS) await sql.unsafe(stmt);
    // meta must exist before we can read/write schema_version. Created as a
    // standalone CREATE IF NOT EXISTS so the drift check can run before we
    // apply the rest of SCHEMA_STATEMENTS.
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    // v4→v5 leftover: indexer_state was retired before v4 shipped and is
    // not in OWNED_TABLES, so the drift path doesn't sweep it.
    await sql.unsafe(`DROP TABLE IF EXISTS indexer_state CASCADE`);
    const rows = await sql<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = 'schema_version'
    `;
    const stored =
      rows[0]?.value !== undefined && rows[0].value !== null ? Number(rows[0].value) : null;

    if (stored !== SCHEMA_VERSION) {
      // Drop-on-drift runs unconditionally. The dashboard DB is purely indexer
      // state derived from the chain + miner REST; nothing here is canonical,
      // so a wipe is recoverable on the next indexer poll.
      console.warn(
        `[db] SCHEMA DRIFT detected (stored=${stored ?? "none"}, code=${SCHEMA_VERSION}); dropping all owned tables`,
      );
      for (const table of OWNED_TABLES) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
      // meta was just dropped — recreate before the drift-write below would
      // otherwise hit a missing table.
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    }

    for (const stmt of SCHEMA_STATEMENTS) await sql.unsafe(stmt);
    await sql`
      INSERT INTO meta (key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
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
        energy, diversity, num_valid_solutions, quality_milli, mining_time,
        reward, nonce, num_nodes, num_edges,
        difficulty_energy, min_diversity, min_solutions, finalized
      ) VALUES (
        ${b.blockHash}, ${b.substrateBlockNumber}, ${b.substrateBlockHash}, ${b.substrateParentHash},
        ${b.timestamp}, ${b.minerId},
        ${b.energy}, ${b.diversity}, ${b.numValidSolutions}, ${b.qualityMilli}, ${b.miningTime},
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
        spec_name, spec_version, transaction_version, impl_name,
        last_runtime_upgrade, updated_at
      ) VALUES (
        1, ${head.bestBlockNumber}, ${head.bestBlockHash},
        ${head.finalizedBlockNumber}, ${head.finalizedBlockHash}, ${head.finalityLag},
        ${head.runtime.specName}, ${head.runtime.specVersion}, ${head.runtime.transactionVersion},
        ${head.runtime.implName}, ${head.runtime.lastRuntimeUpgrade}, ${head.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        best_block_number = EXCLUDED.best_block_number,
        best_block_hash = EXCLUDED.best_block_hash,
        finalized_block_number = EXCLUDED.finalized_block_number,
        finalized_block_hash = EXCLUDED.finalized_block_hash,
        finality_lag = EXCLUDED.finality_lag,
        spec_name = EXCLUDED.spec_name,
        spec_version = EXCLUDED.spec_version,
        transaction_version = EXCLUDED.transaction_version,
        impl_name = EXCLUDED.impl_name,
        last_runtime_upgrade = EXCLUDED.last_runtime_upgrade,
        updated_at = EXCLUDED.updated_at
      WHERE
        chain_head.best_block_number IS DISTINCT FROM EXCLUDED.best_block_number OR
        chain_head.finalized_block_number IS DISTINCT FROM EXCLUDED.finalized_block_number OR
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
        (observed_at_block, difficulty_energy, min_diversity, min_solutions, min_quality, observed_at)
      VALUES (
        ${snapshot.observedAtBlock}, ${snapshot.difficultyEnergy},
        ${snapshot.minDiversity}, ${snapshot.minSolutions},
        ${snapshot.minQuality}, ${snapshot.observedAt}
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
        min_quality: number;
        observed_at: Date;
      }[]
    >`SELECT * FROM difficulty_history ORDER BY observed_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      observedAtBlock: r.observed_at_block,
      difficultyEnergy: r.difficulty_energy,
      minDiversity: r.min_diversity,
      minSolutions: r.min_solutions,
      minQuality: r.min_quality,
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
    qualityMilli: Number(row.quality_milli),
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
