# Database Schema

The dashboard stores indexer-derived telemetry in **PostgreSQL** (the only
supported backend; `docker compose up -d postgres` starts a local instance). The
schema is defined in `migrations/` and applied with the dedicated migrate
command:

```sh
bun run migrate            # apply all pending migrations (forward-only)
bun run migrate status     # list every migration and whether it is applied
bun run migrate dry-run    # list migrations that `up` would apply, without applying
```

Migrations are **forward-only** (no down migrations, no drop-on-drift wipe) and
tracked in Kysely's `kysely_migration` ledger. They never run on the serverless
read path — only via the command above (the docker entrypoint and deploy
pipeline run it before starting the app).

Nothing here is canonical state: every row is derived from the chain and the
miner's local REST API, so a lost database is rebuilt by re-indexing.

## Conventions

These conventions explain the column type choices in the tables below.

| Convention             | Type               | Notes                                                                                                                                                            |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **u64/u128 as string** | `NUMERIC`          | Block numbers, slots, balances, nonces, and nanosecond timestamps exceed an 8-byte signed range or need exact decimal precision; carried as strings in app code. |
| **unix seconds**       | `BIGINT`           | Wall-clock timestamps as seconds since the epoch.                                                                                                                |
| **big counters**       | `BIGINT`           | Monotonic counts and milli-unit values that can grow past 32 bits.                                                                                               |
| **floats**             | `DOUBLE PRECISION` | Energy / diversity / mining-time measurements.                                                                                                                   |
| **booleans**           | `BOOLEAN`          | Flags.                                                                                                                                                           |
| **ISO timestamps**     | `TIMESTAMPTZ`      | `updated_at` / `observed_at` style audit columns; written/read as ISO-8601.                                                                                      |
| **JSON**               | `JSONB`            | Structured blobs (`miners`, `descriptor`).                                                                                                                       |
| **milli-units**        | `BIGINT`           | Energy/diversity/threshold scaled ×1000 to keep integers; the UI divides by 1000 at display time.                                                                |

---

## `blocks`

Won proof-of-work blocks. The substrate worker is the sole writer; rows are
inserted once (`ON CONFLICT DO NOTHING`) and only
`finalized` is later updated.

| Column                   | PostgreSQL       | Null | Description                                                       |
| ------------------------ | ---------------- | ---- | ----------------------------------------------------------------- |
| `block_hash`             | TEXT             | PK   | Dashboard primary key — the PoW block's hash.                     |
| `substrate_block_number` | NUMERIC          | no   | Substrate block height (u64-as-string).                           |
| `substrate_block_hash`   | TEXT             | no   | Substrate block hash.                                             |
| `substrate_parent_hash`  | TEXT             | no   | Parent block hash.                                                |
| `timestamp`              | BIGINT           | no   | Block production time (unix seconds).                             |
| `miner_id`               | TEXT             | no   | SS58 account that won the block.                                  |
| `energy`                 | DOUBLE PRECISION | no   | Energy of the winning solution.                                   |
| `diversity`              | DOUBLE PRECISION | no   | Diversity of the winning solution.                                |
| `num_valid_solutions`    | INTEGER          | no   | Count of valid solutions in the block.                            |
| `mining_time`            | DOUBLE PRECISION | no   | Seconds spent mining this block.                                  |
| `reward`                 | NUMERIC          | no   | Block reward (planck, u128-as-string).                            |
| `nonce`                  | NUMERIC          | no   | Winning nonce (u64-as-string).                                    |
| `num_nodes`              | INTEGER          | no   | Problem graph node count.                                         |
| `num_edges`              | INTEGER          | no   | Problem graph edge count.                                         |
| `difficulty_energy`      | DOUBLE PRECISION | no   | Energy threshold in force for this block.                         |
| `min_diversity`          | DOUBLE PRECISION | no   | Diversity requirement in force.                                   |
| `min_solutions`          | INTEGER          | no   | Minimum solutions requirement in force.                           |
| `finalized`              | BOOLEAN          | no   | Whether the block is finalized; flipped monotonically false→true. |

Indexes: `(substrate_block_number DESC)`, `(miner_id, substrate_block_number DESC)`,
`(timestamp DESC)`.

## `miner_hardware`

Per-miner hardware inventory. In v0.3 only one row per account is written
(`source = 'self'`).

| Column         | PostgreSQL  | Null | Description                                                |
| -------------- | ----------- | ---- | ---------------------------------------------------------- |
| `account_id`   | TEXT        | PK   | Miner SS58 account.                                        |
| `node_id`      | TEXT        | no   | Reporting node identifier.                                 |
| `miners`       | JSONB       | no   | JSON array of hardware entries (type, count, etc.).        |
| `primary_type` | TEXT        | no   | Dominant miner backend (CPU / CUDA / METAL / MODAL / QPU). |
| `source`       | TEXT        | no   | Origin of the row (e.g. `self`).                           |
| `observed_at`  | TIMESTAMPTZ | no   | When the inventory was observed.                           |

Indexes: `(observed_at DESC)`.

## `meta`

Generic key/value store, avoiding dedicated single-value tables.

| Column  | PostgreSQL | Null | Description                         |
| ------- | ---------- | ---- | ----------------------------------- |
| `key`   | TEXT       | PK   | Meta key.                           |
| `value` | TEXT       | yes  | Opaque value (string or JSON text). |

Known keys: `self_address` (the local validator's SS58), `indexer_observability`
(JSON health/minerStats blob), `descriptor_checkpoint` (last block scanned for
node descriptors), `mining_checkpoint:<ss58>` (per-miner submission cursor).

## `chain_head`

Singleton (`id = 1`) snapshot of the chain head and runtime.

| Column                    | PostgreSQL  | Null | Description                                                                                                                                              |
| ------------------------- | ----------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | INTEGER     | PK   | Always 1 (`CHECK (id = 1)`).                                                                                                                             |
| `best_block_number`       | NUMERIC     | no   | Best (non-finalized) block height.                                                                                                                       |
| `best_block_hash`         | TEXT        | no   | Best block hash.                                                                                                                                         |
| `finalized_block_number`  | NUMERIC     | no   | Finalized block height.                                                                                                                                  |
| `finalized_block_hash`    | TEXT        | no   | Finalized block hash.                                                                                                                                    |
| `finality_lag`            | INTEGER     | no   | best − finalized height.                                                                                                                                 |
| `winning_solutions_count` | BIGINT      | yes  | `quantum_pow.LatestQBlockId` (legacy `WinningSolutions` count fallback); `id + 1` is the in-flight problem. Null on pre-v0.2 chains / before first read. |
| `spec_name`               | TEXT        | no   | Runtime spec name.                                                                                                                                       |
| `spec_version`            | INTEGER     | no   | Runtime spec version.                                                                                                                                    |
| `transaction_version`     | INTEGER     | no   | Runtime transaction version.                                                                                                                             |
| `impl_name`               | TEXT        | no   | Runtime implementation name.                                                                                                                             |
| `last_runtime_upgrade`    | NUMERIC     | yes  | Block of the last runtime upgrade (u64-as-string).                                                                                                       |
| `updated_at`              | TIMESTAMPTZ | no   | When this snapshot was written.                                                                                                                          |

## `babe_epochs`

BABE epoch state; `is_current` marks the active epoch.

| Column                  | PostgreSQL  | Null | Description                                  |
| ----------------------- | ----------- | ---- | -------------------------------------------- |
| `epoch_index`           | INTEGER     | PK   | Epoch index.                                 |
| `current_slot`          | NUMERIC     | no   | Current slot number (u64-as-string).         |
| `epoch_start_slot`      | NUMERIC     | no   | First slot of the epoch.                     |
| `slots_per_epoch`       | INTEGER     | no   | Slot count per epoch.                        |
| `current_slot_in_epoch` | INTEGER     | no   | Offset of the current slot within the epoch. |
| `authority_count`       | INTEGER     | no   | Number of authorities for the epoch.         |
| `is_current`            | BOOLEAN     | no   | Whether this is the active epoch.            |
| `updated_at`            | TIMESTAMPTZ | no   | When the row was written.                    |

Indexes: `(is_current)` — partial (`WHERE is_current`).

## `babe_authorities`

Per-epoch authority set. Composite primary key `(account_id, epoch_index)`.

| Column         | PostgreSQL  | Null | Description                                   |
| -------------- | ----------- | ---- | --------------------------------------------- |
| `account_id`   | TEXT        | PK   | Authority SS58 account.                       |
| `epoch_index`  | INTEGER     | PK   | Epoch this authority entry belongs to.        |
| `display_name` | TEXT        | yes  | Optional human-readable name.                 |
| `is_active`    | BOOLEAN     | no   | Whether the authority is active in the epoch. |
| `updated_at`   | TIMESTAMPTZ | no   | When the row was written.                     |

Indexes: `(epoch_index, is_active)`.

## `chain_miners`

On-chain miner registry stats.

| Column             | PostgreSQL  | Null | Description                                    |
| ------------------ | ----------- | ---- | ---------------------------------------------- |
| `account_id`       | TEXT        | PK   | Miner SS58 account.                            |
| `deposit`          | NUMERIC     | no   | Registration deposit (planck, u128-as-string). |
| `proofs_submitted` | NUMERIC     | no   | Lifetime proofs submitted.                     |
| `proofs_won`       | NUMERIC     | no   | Lifetime proofs won.                           |
| `rewards_earned`   | NUMERIC     | no   | Lifetime rewards (planck).                     |
| `updated_at`       | TIMESTAMPTZ | no   | When the row was written.                      |

Indexes: `(rewards_earned DESC)`.

## `difficulty_history`

Append-only difficulty snapshots, keyed by the block at which they were observed.

| Column              | PostgreSQL       | Null | Description                                   |
| ------------------- | ---------------- | ---- | --------------------------------------------- |
| `observed_at_block` | NUMERIC          | PK   | Block height of the snapshot (u64-as-string). |
| `difficulty_energy` | DOUBLE PRECISION | no   | Energy threshold at that block.               |
| `min_diversity`     | DOUBLE PRECISION | no   | Diversity requirement at that block.          |
| `min_solutions`     | INTEGER          | no   | Minimum solutions requirement at that block.  |
| `observed_at`       | TIMESTAMPTZ      | no   | Wall-clock time of observation.               |

Indexes: `(observed_at DESC)`.

## `validator_authorship`

Per-validator authorship counters, one row per observed author.

| Column                     | PostgreSQL  | Null | Description                                                                |
| -------------------------- | ----------- | ---- | -------------------------------------------------------------------------- |
| `account_id`               | TEXT        | PK   | Validator SS58 account.                                                    |
| `blocks_authored`          | BIGINT      | no   | Total blocks authored (default 0).                                         |
| `blocks_authored_with_pow` | BIGINT      | no   | Blocks authored that carried a PoW seal (default 0).                       |
| `last_authored_block`      | NUMERIC     | no   | Height of the most recent authored block.                                  |
| `last_authored_at`         | TIMESTAMPTZ | no   | ISO-8601 time of the last authored block; backs the online/offline window. |

Indexes: `(blocks_authored DESC)`.

## `node_descriptors`

Per-account chain-signed identity, sourced from `MinerRegistry.NodeDescriptors`
by the descriptor worker. `(block_number, extrinsic_index)` stays as the upsert
tie-breaker for compatibility; registry snapshots use `extrinsic_index = 0` and
the descriptor's own `updated_at` block number.

| Column                  | PostgreSQL  | Null | Description                                                   |
| ----------------------- | ----------- | ---- | ------------------------------------------------------------- |
| `account_id`            | TEXT        | PK   | Account the descriptor belongs to.                            |
| `block_number`          | NUMERIC     | no   | Block of the descriptor extrinsic (u64-as-string).            |
| `block_hash`            | TEXT        | no   | Hash of that block.                                           |
| `extrinsic_index`       | INTEGER     | no   | Index of the extrinsic within the block (tie-breaker).        |
| `block_timestamp`       | BIGINT      | no   | Time of the descriptor block (unix seconds).                  |
| `first_block_timestamp` | BIGINT      | no   | Time first observed; preserved across upserts ("first seen"). |
| `descriptor`            | JSONB       | no   | The signed descriptor payload (JSON).                         |
| `observed_at`           | TIMESTAMPTZ | no   | When the row was written.                                     |

Indexes: `(block_number DESC)`, `((coalesce(descriptor->>'nodeName', account_id)))`.

## `mining_submissions`

Per-submission summaries polled from the local miner's
`/api/v1/mining/attempts?solution_number=N` endpoint. Composite primary key
`(miner_id, solution_number)` so polling multiple miners never collides.
`solution_number` is the global chain solution index
(`LatestQBlockId + 1`), durable across restarts.

| Column                  | PostgreSQL  | Null | Description                                                                                               |
| ----------------------- | ----------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `miner_id`              | TEXT        | PK   | Polled miner SS58 account.                                                                                |
| `solution_number`       | BIGINT      | PK   | Global chain solution number.                                                                             |
| `ts_ns`                 | NUMERIC     | no   | Submission timestamp in nanoseconds (u128-as-string).                                                     |
| `energy_milli`          | BIGINT      | no   | Solution energy ×1000.                                                                                    |
| `diversity_milli`       | BIGINT      | no   | Solution diversity ×1000.                                                                                 |
| `threshold_milli`       | BIGINT      | no   | Energy threshold ×1000.                                                                                   |
| `last_proof_block_hash` | TEXT        | no   | Block hash of the last proof in the attempt.                                                              |
| `extrinsic_hash`        | TEXT        | yes  | Submission extrinsic hash; null until it lands on chain.                                                  |
| `chain_block_hash`      | TEXT        | yes  | Winning block hash; null for non-winning / not-yet-landed.                                                |
| `chain_block_number`    | NUMERIC     | yes  | Winning block height (u64-as-string); null when not a winner.                                             |
| `pow_sequence`          | BIGINT      | yes  | On-chain `proofs_submitted` sequence for non-winning submissions; null for winners and pre-MR!105 miners. |
| `outcome`               | TEXT        | no   | Submission outcome (e.g. won / submitted).                                                                |
| `attempt_count`         | INTEGER     | no   | Number of attempts in the submission.                                                                     |
| `best_energy_milli`     | BIGINT      | no   | Best energy seen across attempts ×1000.                                                                   |
| `num_valid`             | INTEGER     | no   | Count of valid solutions (default 0).                                                                     |
| `miner_type`            | TEXT        | no   | Backend that produced the submission (CPU / CUDA / METAL / MODAL / QPU); empty if unreported.             |
| `qpu_access_time_us`    | BIGINT      | no   | Summed D-Wave QPU access time across iterations (µs); emitted per-attempt by miners since v0.2.0. 0 for non-QPU rows (default 0). |
| `observed_at`           | TIMESTAMPTZ | no   | When the row was written.                                                                                 |

Indexes: `(miner_id, solution_number DESC)`, `(miner_id) WHERE attempt_count > 0` — partial.

---

## Migration-tooling tables

Managed by Kysely; do not write to them directly.

| Table                   | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `kysely_migration`      | Ledger of applied migrations (`name`, `timestamp`).   |
| `kysely_migration_lock` | Advisory lock row guarding concurrent migration runs. |
