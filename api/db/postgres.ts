// SPDX-License-Identifier: AGPL-3.0-or-later

import postgres, { type Sql } from "postgres";

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
  isLocalDeployment,
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
     timestamp              BIGINT NOT NULL,
     previous_hash          TEXT NOT NULL,
     miner_id               TEXT NOT NULL,
     miner_category         TEXT NOT NULL,
     ecdsa_public_key       TEXT NOT NULL,
     energy                 DOUBLE PRECISION NOT NULL,
     diversity              DOUBLE PRECISION NOT NULL,
     num_valid_solutions    INTEGER NOT NULL,
     mining_time            DOUBLE PRECISION NOT NULL,
     nonce                  NUMERIC NOT NULL,
     num_nodes              INTEGER NOT NULL,
     num_edges              INTEGER NOT NULL,
     difficulty_energy      DOUBLE PRECISION NOT NULL,
     min_diversity          DOUBLE PRECISION NOT NULL,
     min_solutions          INTEGER NOT NULL,
     substrate_block_number TEXT,
     substrate_block_hash   TEXT,
     substrate_parent_hash  TEXT,
     extrinsics_root        TEXT,
     state_root             TEXT,
     finalized              BOOLEAN NOT NULL DEFAULT FALSE,
     is_canonical           BOOLEAN NOT NULL DEFAULT TRUE,
     PRIMARY KEY (epoch, block_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_canonical_ts ON blocks(is_canonical, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_substrate_hash ON blocks(substrate_block_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_substrate_number ON blocks(substrate_block_number)`,
  // Postgres supports partial index — only finalized rows live in the index.
  `CREATE INDEX IF NOT EXISTS idx_blocks_finalized ON blocks(finalized) WHERE finalized`,
  // Composite covers the BlockWinner-event join (miner_id, energy) and
  // orders newest-first to keep findBlockByMinerAndEnergy O(log n) + 1.
  `CREATE INDEX IF NOT EXISTS idx_blocks_miner_energy ON blocks(miner_id, energy, timestamp DESC)`,
  `CREATE TABLE IF NOT EXISTS nodes_snapshot (
     id      INTEGER PRIMARY KEY CHECK (id = 1),
     payload JSONB NOT NULL
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
  // v5 substrate-derived tables. NUMERIC for u64/u128 columns to preserve
  // precision; BIGINT for fields that fit in 63 bits (era_start_time).
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
];

const SELF_ADDRESS_KEY = "self_address";
const INDEXER_OBSERVABILITY_KEY = "indexer_observability";
const INDEXER_CURSORS_KEY = "indexer_cursors";

interface BlockRow {
  epoch: string;
  block_index: number;
  block_hash: string;
  // timestamp is BIGINT which postgres-js returns as string to preserve
  // precision; Number() is safe here because unix seconds fit comfortably
  // inside MAX_SAFE_INTEGER.
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
  // u64 NUMERIC — postgres-js returns NUMERIC as string to preserve precision.
  substrate_block_number: string | null;
  substrate_block_hash: string | null;
  substrate_parent_hash: string | null;
  extrinsics_root: string | null;
  state_root: string | null;
  finalized: boolean;
  is_canonical: boolean;
}

function rowToBlock(r: BlockRow): BlockRecord {
  return {
    epoch: r.epoch,
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
    substrateBlockNumber: r.substrate_block_number,
    substrateBlockHash: r.substrate_block_hash,
    substrateParentHash: r.substrate_parent_hash,
    extrinsicsRoot: r.extrinsics_root,
    stateRoot: r.state_root,
    finalized: r.finalized,
    isCanonical: r.is_canonical,
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
    // v4→v5 leftover: indexer_state was retired before v4 shipped and is
    // not in OWNED_TABLES, so the drift path doesn't sweep it. Drop once
    // per migrate; becomes a no-op after first v5 run.
    await sql.unsafe(`DROP TABLE IF EXISTS indexer_state CASCADE`);
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
        difficulty_energy, min_diversity, min_solutions,
        substrate_block_number, substrate_block_hash, substrate_parent_hash,
        extrinsics_root, state_root, finalized, is_canonical
      ) VALUES (
        ${b.epoch}, ${b.blockIndex}, ${b.blockHash}, ${b.timestamp}, ${b.previousHash},
        ${b.minerId}, ${b.minerCategory}, ${b.ecdsaPublicKey},
        ${b.energy}, ${b.diversity}, ${b.numValidSolutions}, ${b.miningTime},
        ${b.nonce}, ${b.numNodes}, ${b.numEdges},
        ${b.difficultyEnergy}, ${b.minDiversity}, ${b.minSolutions},
        ${b.substrateBlockNumber}, ${b.substrateBlockHash}, ${b.substrateParentHash},
        ${b.extrinsicsRoot}, ${b.stateRoot}, ${b.finalized}, ${b.isCanonical}
      )
      ON CONFLICT (epoch, block_index) DO NOTHING
    `;
    return result.count > 0;
  }

  async getAllBlocks(): Promise<BlockRecord[]> {
    // Default-filter stale-fork blocks (audit fix #5). Views needing all
    // chains call a future getAllBlocksIncludingForks helper.
    const rows = await this.requireSql()<BlockRow[]>`
      SELECT * FROM blocks WHERE is_canonical = TRUE ORDER BY timestamp, block_index
    `;
    return rows.map(rowToBlock);
  }

  async getBlocksByEpoch(epoch: EpochId): Promise<BlockRecord[]> {
    // No canonical filter — caller asked for a specific epoch.
    const rows = await this.requireSql()<BlockRow[]>`
      SELECT * FROM blocks WHERE epoch = ${epoch} ORDER BY block_index
    `;
    return rows.map(rowToBlock);
  }

  async getIndex(): Promise<TelemetryIndex> {
    const sql = this.requireSql();
    // LEFT JOIN: rows survive while the indexer has persisted blocks for an
    // epoch but the per-poll epoch_status replace hasn't run yet (brief
    // window on first boot). Default to stale_fork so we never spuriously
    // label an epoch "live". first_block_timestamp derives from
    // block_index=1's timestamp; NULL when that block hasn't been indexed.
    const rows = await sql<
      {
        epoch: string;
        block_count: string | number;
        status: string | null;
        first_block_timestamp: string | number | null;
      }[]
    >`
      SELECT b.epoch AS epoch,
             COUNT(*) AS block_count,
             COALESCE(es.status, 'stale_fork') AS status,
             MAX(CASE WHEN b.block_index = 1 THEN b.timestamp END) AS first_block_timestamp
      FROM blocks b
      LEFT JOIN epoch_status es ON es.epoch = b.epoch
      -- es.status grouped because Postgres can't infer functional dependence
      -- on es.epoch (which is PK) across the LEFT JOIN. Adding it is safe:
      -- the join is 1:1 by epoch, so each row's status is identical per group.
      GROUP BY b.epoch, es.status
      ORDER BY first_block_timestamp DESC NULLS LAST, b.epoch
    `;
    const snap = await this.getNodes();
    return {
      epochs: rows.map((r) => ({
        epoch: r.epoch,
        blockCount: Number(r.block_count),
        status: (r.status === "live" ? "live" : "stale_fork") as EpochStatus,
        firstBlockTimestamp:
          r.first_block_timestamp == null ? null : Number(r.first_block_timestamp),
      })),
      lastUpdated: snap?.updatedAt ?? new Date().toISOString(),
    };
  }

  async replaceEpochStatus(entries: EpochStatusEntry[]): Promise<void> {
    const sql = this.requireSql();
    // Atomic swap: a partial write where a chain transitions live →
    // stale_fork would momentarily show two "live" epochs in the UI.
    await sql.begin(async (tx) => {
      await tx`DELETE FROM epoch_status`;
      if (entries.length === 0) return;
      // sql(arrayOfObjects) generates a multi-row VALUES clause.
      await tx`INSERT INTO epoch_status ${tx(entries, "epoch", "status")}`;
    });
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

  async getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }> {
    const rows = await this.requireSql()<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = ${INDEXER_CURSORS_KEY}
    `;
    return parseIndexerCursorsOrDefault(rows[0]?.value ?? null, "postgres");
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
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${INDEXER_CURSORS_KEY}, ${payload})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async getEtags(): Promise<{ nodes: string | null }> {
    const rows = await this.requireSql()<{ value: string | null }[]>`
      SELECT value FROM meta WHERE key = ${INDEXER_CURSORS_KEY}
    `;
    const parsed = parseIndexerCursors(rows[0]?.value ?? null);
    return { nodes: parsed?.etags?.nodes ?? null };
  }

  /** @internal test-only — write a raw value under a meta key. */
  async setMetaRaw(key: string, value: string): Promise<void> {
    await this.requireSql()`
      INSERT INTO meta (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
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

  // --- Substrate-derived state (v5) ---

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
    miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>,
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

  async getChainMiners(): Promise<Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>> {
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
    const sql = this.requireSql();
    const setClauses: string[] = [];
    const params: Array<string | boolean | null> = [];
    let i = 1;
    const next = (v: string | boolean | null): string => {
      params.push(v);
      return `$${i++}`;
    };
    if (fields.substrateBlockNumber !== undefined) {
      setClauses.push(
        `substrate_block_number = COALESCE(${next(fields.substrateBlockNumber)}, substrate_block_number)`,
      );
    }
    if (fields.substrateBlockHash !== undefined) {
      setClauses.push(
        `substrate_block_hash = COALESCE(${next(fields.substrateBlockHash)}, substrate_block_hash)`,
      );
    }
    if (fields.substrateParentHash !== undefined) {
      setClauses.push(
        `substrate_parent_hash = COALESCE(${next(fields.substrateParentHash)}, substrate_parent_hash)`,
      );
    }
    if (fields.extrinsicsRoot !== undefined) {
      setClauses.push(
        `extrinsics_root = COALESCE(${next(fields.extrinsicsRoot)}, extrinsics_root)`,
      );
    }
    if (fields.stateRoot !== undefined) {
      setClauses.push(`state_root = COALESCE(${next(fields.stateRoot)}, state_root)`);
    }
    if (fields.finalized === true) {
      // Monotonic: only flip false → true.
      setClauses.push("finalized = TRUE");
    }
    if (setClauses.length === 0) {
      return { matched: true };
    }
    const epochParam = next(epoch);
    const indexParam = `$${i++}`;
    params.push(String(blockIndex));
    const result = await sql.unsafe(
      `UPDATE blocks SET ${setClauses.join(", ")} WHERE epoch = ${epochParam} AND block_index = ${indexParam}`,
      params as unknown as never[],
    );
    return { matched: result.count > 0 };
  }

  async findBlockByMinerAndEnergy(
    minerId: string,
    energy: number,
  ): Promise<{ epoch: EpochId; blockIndex: number } | null> {
    const rows = await this.requireSql()<{ epoch: string; block_index: number }[]>`
      SELECT epoch, block_index FROM blocks
      WHERE miner_id = ${minerId} AND energy = ${energy}
      ORDER BY timestamp DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { epoch: row.epoch, blockIndex: row.block_index };
  }

  async markBlocksCanonical(epochs: EpochId[], canonical: boolean): Promise<void> {
    if (epochs.length === 0) return;
    await this.requireSql()`
      UPDATE blocks SET is_canonical = ${canonical}
      WHERE epoch IN ${this.requireSql()(epochs)}
    `;
  }

  async updateEpochChainAnchor(epoch: EpochId, chainAnchor: string): Promise<void> {
    await this.requireSql()`
      UPDATE epoch_status SET chain_anchor = ${chainAnchor} WHERE epoch = ${epoch}
    `;
  }

  private requireSql(): Sql {
    if (!this.sql) {
      throw new Error("PostgresAdapter not connected. Call connect() first.");
    }
    return this.sql;
  }
}
