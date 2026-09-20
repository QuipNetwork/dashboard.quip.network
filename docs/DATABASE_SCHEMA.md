# Database schema

The dashboard stores indexer-derived telemetry in two storage backends. With
no `DATABASE_URL`, it uses **embedded Turso** (a local file). With a valid
`DATABASE_URL`, it uses **Postgres**. Both backends share the same domain
operations, the same schema, and a serialized single-writer boundary.

A schema change is a new additive migration. Migrations use numbered SQL files
under `crates/dashboard-store/migrations/postgres/` and
`crates/dashboard-store/migrations/turso/`, registered in
`crates/dashboard-store/src/migrations.rs`. A change must update both backend
copies consistently. Apply with the migrate command:

```sh
quip-dashboard migrate                # apply all pending migrations (forward-only)
quip-dashboard migrate status         # list every migration and whether it is applied
quip-dashboard migrate dry-run        # list migrations `up` would apply, without applying
```

Migrations are forward-only (no down migrations and no drop-on-drift wipe).
Each migration runs in its own transaction and records its name and execution
timestamp in the `kysely_migration` ledger. The ledger preserves the historical
Kysely migration names, so an existing database migrates forward without a
wipe. The backend runs migrations before it admits API requests.

The chain and miner REST API supply these records. Reindexing can recover
only the history that upstream services still retain. Back up the database
to preserve data beyond those retention limits.

## Conventions

These conventions explain the column type choices in the tables below.

| Convention             | Type                                      | Notes                                                                                                                            |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **u64/u128 as string** | `NUMERIC` or decimal `TEXT`               | Block numbers, slots, balances, nonces, and nanosecond timestamps exceed an 8-byte signed range or need exact decimal precision. |
| **unix seconds**       | `BIGINT`                                  | Wall-clock timestamps as seconds since the epoch.                                                                                |
| **big counters**       | `BIGINT`                                  | Monotonic counts and milli-unit values that can grow past 32 bits.                                                               |
| **floats**             | `DOUBLE PRECISION`                        | Energy, diversity, and mining-time measurements.                                                                                 |
| **booleans**           | `BOOLEAN`                                 | Flags such as `finalized` and `is_current`.                                                                                      |
| **ISO timestamps**     | `TIMESTAMPTZ` (Postgres) / `TEXT` (Turso) | `updated_at` and `observed_at` audit columns, read, and written as RFC 3339 UTC.                                                 |
| **JSON**               | `JSONB` (Postgres) / `TEXT` (Turso)       | Structured blobs such as `miners` and `descriptor`.                                                                              |
| **milli-units**        | `BIGINT`                                  | Energy, diversity, and threshold scaled by 1000 to keep integers. The UI divides by 1000 at display.                             |

Decimal ordering and comparison use text-length-aware SQL so that numeric
values stored as text compare correctly.

## The four indexable domains

The indexer maintains four independent block domains, each with its own
persisted generation, coverage state, and pruning floor. A domain below its
pruning floor suppresses unavailable work without adding coverage.

- `winners` — block winners and their solution details.
- `difficulty` — difficulty snapshots.
- `participation` — the post-selection participation ledger.
- `authorship` — validator authorship counters and per-block records.

`list-indexables` reports each domain name with its persisted generation and
coverage. `reindex` drops owned history for the domains (no argument selects
all four).

## `blocks`

Won proof-of-work blocks. The indexer writes rows once and only later updates
`finalized`.

| Column                   | Type             | Null | Description                                                |
| ------------------------ | ---------------- | ---- | ---------------------------------------------------------- |
| `block_hash`             | TEXT             | PK   | Dashboard primary key, the PoW block hash.                 |
| `qblock_id`              | NUMERIC          | no   | Global solution number. Default 0.                         |
| `substrate_block_number` | NUMERIC          | no   | Substrate block height (u64-as-string).                    |
| `substrate_block_hash`   | TEXT             | no   | Substrate block hash.                                      |
| `substrate_parent_hash`  | TEXT             | no   | Parent block hash.                                         |
| `timestamp`              | BIGINT           | no   | Block production time (unix seconds).                      |
| `miner_id`               | TEXT             | no   | SS58 account that won the block.                           |
| `energy`                 | DOUBLE PRECISION | no   | Energy of the winning solution.                            |
| `diversity`              | DOUBLE PRECISION | no   | Diversity of the winning solution.                         |
| `num_valid_solutions`    | INTEGER          | no   | Count of valid solutions in the block.                     |
| `mining_time`            | DOUBLE PRECISION | no   | Seconds of compute behind the win.                         |
| `device_access_time_us`  | NUMERIC          | yes  | Reported microseconds of device compute. Null when absent. |
| `reward`                 | NUMERIC          | no   | Block reward (planck, u128-as-string).                     |
| `nonce`                  | NUMERIC          | no   | Winning nonce (u64-as-string).                             |
| `num_nodes`              | INTEGER          | no   | Problem graph node count.                                  |
| `num_edges`              | INTEGER          | no   | Problem graph edge count.                                  |
| `difficulty_energy`      | DOUBLE PRECISION | no   | Energy threshold in force for this block.                  |
| `min_diversity`          | DOUBLE PRECISION | no   | Diversity requirement in force.                            |
| `min_solutions`          | INTEGER          | no   | Minimum solutions requirement in force.                    |
| `finalized`              | BOOLEAN          | no   | Block finality flag. Changes from false to true.           |

Indexes: `(substrate_block_number DESC)`, `(miner_id, substrate_block_number
DESC)`, `(timestamp DESC)`, `(qblock_id)`.

## `miner_hardware`

Per-miner hardware inventory.

| Column         | Type        | Null | Description                                            |
| -------------- | ----------- | ---- | ------------------------------------------------------ |
| `account_id`   | TEXT        | PK   | Miner SS58 account.                                    |
| `node_id`      | TEXT        | no   | Reporting node identifier.                             |
| `miners`       | JSONB       | no   | JSON array of hardware entries.                        |
| `primary_type` | TEXT        | no   | Dominant miner backend (CPU, CUDA, METAL, MODAL, QPU). |
| `source`       | TEXT        | no   | Origin of the row.                                     |
| `observed_at`  | TIMESTAMPTZ | no   | Inventory observation time.                            |

Index: `(observed_at DESC)`.

## `meta`

Generic key/value store.

| Column  | Type | Null | Description                         |
| ------- | ---- | ---- | ----------------------------------- |
| `key`   | TEXT | PK   | Meta key.                           |
| `value` | TEXT | yes  | Opaque value (string or JSON text). |

Known keys include `self_address`, `indexer_observability`, and the scanning
checkpoints.

## `chain_head`

Singleton (`id = 1`) snapshot of the chain head and runtime.

| Column                        | Type        | Null | Description                                        |
| ----------------------------- | ----------- | ---- | -------------------------------------------------- |
| `id`                          | INTEGER     | PK   | Always 1.                                          |
| `best_block_number`           | NUMERIC     | no   | Best (non-finalized) block height.                 |
| `best_block_hash`             | TEXT        | no   | Best block hash.                                   |
| `finalized_block_number`      | NUMERIC     | no   | Finalized block height.                            |
| `finalized_block_hash`        | TEXT        | no   | Finalized block hash.                              |
| `finality_lag`                | INTEGER     | no   | best minus finalized height.                       |
| `winning_solutions_count`     | NUMERIC     | yes  | Latest QBlock id plus one. Null before first read. |
| `current_qblock_id`           | NUMERIC     | yes  | Current problem solution number.                   |
| `current_qblock_participants` | INTEGER     | yes  | Current problem participant count.                 |
| `spec_name`                   | TEXT        | no   | Runtime specification name.                        |
| `spec_version`                | INTEGER     | no   | Runtime specification version.                     |
| `transaction_version`         | INTEGER     | no   | Runtime transaction version.                       |
| `impl_name`                   | TEXT        | no   | Runtime implementation name.                       |
| `last_runtime_upgrade`        | NUMERIC     | yes  | Block of the last runtime upgrade.                 |
| `updated_at`                  | TIMESTAMPTZ | no   | Snapshot write time.                               |

## `babe_epochs`

BABE epoch state. `is_current` marks the active epoch.

| Column                  | Type        | Null | Description                                  |
| ----------------------- | ----------- | ---- | -------------------------------------------- |
| `epoch_index`           | INTEGER     | PK   | Epoch index.                                 |
| `current_slot`          | NUMERIC     | no   | Current slot number (u64-as-string).         |
| `epoch_start_slot`      | NUMERIC     | no   | First slot of the epoch.                     |
| `slots_per_epoch`       | INTEGER     | no   | Slot count per epoch.                        |
| `current_slot_in_epoch` | INTEGER     | no   | Offset of the current slot within the epoch. |
| `authority_count`       | INTEGER     | no   | Number of authorities for the epoch.         |
| `is_current`            | BOOLEAN     | no   | Whether this is the active epoch.            |
| `updated_at`            | TIMESTAMPTZ | no   | Row write time.                              |

Index: `(is_current)` partial, where `is_current`.

## `babe_authorities`

Per-epoch authority set. Key `(account_id, epoch_index)`.

| Column         | Type        | Null | Description                      |
| -------------- | ----------- | ---- | -------------------------------- |
| `account_id`   | TEXT        | PK   | Authority SS58 account.          |
| `epoch_index`  | INTEGER     | PK   | Epoch this entry belongs to.     |
| `display_name` | TEXT        | yes  | Optional human-readable name.    |
| `is_active`    | BOOLEAN     | no   | Whether the authority is active. |
| `updated_at`   | TIMESTAMPTZ | no   | Row write time.                  |

Index: `(epoch_index, is_active)`.

## `chain_miners`

On-chain miner registry stats.

| Column             | Type        | Null | Description                    |
| ------------------ | ----------- | ---- | ------------------------------ |
| `account_id`       | TEXT        | PK   | Miner SS58 account.            |
| `deposit`          | NUMERIC     | no   | Registration deposit (planck). |
| `proofs_submitted` | NUMERIC     | no   | Lifetime proofs submitted.     |
| `proofs_won`       | NUMERIC     | no   | Lifetime proofs won.           |
| `rewards_earned`   | NUMERIC     | no   | Lifetime rewards (planck).     |
| `updated_at`       | TIMESTAMPTZ | no   | Row write time.                |

Index: `(rewards_earned DESC)`.

## `difficulty_history`

Append-only difficulty snapshots, keyed by their observation block.

| Column              | Type             | Null | Description                                  |
| ------------------- | ---------------- | ---- | -------------------------------------------- |
| `observed_at_block` | NUMERIC          | PK   | Block height of the snapshot.                |
| `difficulty_energy` | DOUBLE PRECISION | no   | Energy threshold at that block.              |
| `min_diversity`     | DOUBLE PRECISION | no   | Diversity requirement at that block.         |
| `min_solutions`     | INTEGER          | no   | Minimum solutions requirement at that block. |
| `source`            | TEXT             | no   | Origin of the snapshot, default `poll`.      |
| `observed_at`       | TIMESTAMPTZ      | no   | Wall-clock time of observation.              |

Index: `(observed_at DESC)`.

## `validator_authorship`

Per-validator authorship counters, one row per observed author.

| Column                     | Type        | Null | Description                               |
| -------------------------- | ----------- | ---- | ----------------------------------------- |
| `account_id`               | TEXT        | PK   | Validator SS58 account.                   |
| `blocks_authored`          | BIGINT      | no   | Total blocks authored, default 0.         |
| `blocks_authored_with_pow` | BIGINT      | no   | Blocks with a PoW seal, default 0.        |
| `last_authored_block`      | NUMERIC     | no   | Height of the most recent authored block. |
| `last_authored_at`         | TIMESTAMPTZ | no   | Time of the last authored block.          |

Index: `(blocks_authored DESC)`.

## `validator_authorship_blocks`

Per-validator per-block authorship records.

| Column         | Type        | Null | Description                         |
| -------------- | ----------- | ---- | ----------------------------------- |
| `validator`    | TEXT        | PK   | Validator account.                  |
| `block_number` | NUMERIC     | PK   | Authored block height.              |
| `timestamp`    | TIMESTAMPTZ | no   | Block time.                         |
| `had_winner`   | BOOLEAN     | no   | Whether the block carried a winner. |

Indexes: `(validator, had_winner)`, `(block_number)`.

## `node_descriptors`

Per-account chain-signed identity. `(block_number, extrinsic_index)` is the
upsert tie-breaker. Registry snapshots use `extrinsic_index = 0`.

| Column                  | Type        | Null | Description                                    |
| ----------------------- | ----------- | ---- | ---------------------------------------------- |
| `account_id`            | TEXT        | PK   | Account the descriptor belongs to.             |
| `block_number`          | NUMERIC     | no   | Block of the descriptor extrinsic.             |
| `block_hash`            | TEXT        | no   | Hash of that block.                            |
| `extrinsic_index`       | INTEGER     | no   | Index of the extrinsic within the block.       |
| `block_timestamp`       | BIGINT      | no   | Time of the descriptor block (unix seconds).   |
| `first_block_timestamp` | BIGINT      | no   | Time first observed, preserved across upserts. |
| `descriptor`            | JSONB       | no   | The signed descriptor payload.                 |
| `node_name`             | TEXT        | yes  | Materialized descriptor node name.             |
| `observed_at`           | TIMESTAMPTZ | no   | Row write time.                                |

Indexes: `(block_number DESC)`, `((coalesce(descriptor->>'nodeName',
account_id)))`, `(coalesce(node_name, account_id), account_id)`.

## `mining_submissions`

Per-submission summaries polled from the local miner. Key
`(miner_id, solution_number)` so polling miners never collides.
`solution_number` is the chain qblock id that the submission competes for. It
is durable across restarts. The miner reports a submission under the last
accepted qblock id, which is 1 lower. The dashboard adds 1 when it reads the
miner. Migration `0011_chain_numbered_mining_submissions` shifted the rows that
earlier writers stored with the miner number.

| Column                  | Type        | Null | Description                                     |
| ----------------------- | ----------- | ---- | ----------------------------------------------- |
| `miner_id`              | TEXT        | PK   | Polled miner SS58 account.                      |
| `solution_number`       | NUMERIC     | PK   | Global chain solution number.                   |
| `ts_ns`                 | NUMERIC     | no   | Submission timestamp in nanoseconds.            |
| `energy_milli`          | BIGINT      | no   | Solution energy times 1000.                     |
| `diversity_milli`       | BIGINT      | no   | Solution diversity times 1000.                  |
| `threshold_milli`       | BIGINT      | no   | Energy threshold times 1000.                    |
| `last_proof_block_hash` | TEXT        | no   | Block hash of the last proof in the attempt.    |
| `extrinsic_hash`        | TEXT        | yes  | Submission extrinsic hash, null until on chain. |
| `chain_block_hash`      | TEXT        | yes  | Winning block hash, null when not a win.        |
| `chain_block_number`    | NUMERIC     | yes  | Winning block height, null when not a winner.   |
| `pow_sequence`          | NUMERIC     | yes  | On-chain proofs submitted sequence.             |
| `outcome`               | TEXT        | no   | Submission outcome.                             |
| `attempt_count`         | INTEGER     | no   | Number of attempts in the submission.           |
| `best_energy_milli`     | BIGINT      | no   | Best energy across attempts times 1000.         |
| `num_valid`             | INTEGER     | no   | Count of valid solutions, default 0.            |
| `miner_type`            | TEXT        | no   | Backend that produced the submission.           |
| `qpu_access_time_us`    | NUMERIC     | no   | Summed QPU access time in microseconds.         |
| `observed_at`           | TIMESTAMPTZ | no   | Row write time.                                 |

Indexes: `(miner_id, solution_number DESC)`, `(miner_id)` partial where
`attempt_count > 0`.

## `qblock_participation`

The participation ledger, one row per account per solution.

| Column           | Type    | Null | Description                        |
| ---------------- | ------- | ---- | ---------------------------------- |
| `qblock_id`      | NUMERIC | PK   | Global solution number.            |
| `account`        | TEXT    | PK   | Participant account.               |
| `kind`           | TEXT    | no   | Participation kind.                |
| `budget_seconds` | INTEGER | yes  | Stated budget in seconds.          |
| `block_number`   | TEXT    | no   | Block height of the participation. |

Index: `(qblock_id)`.

## Rust writer state

The Rust writer adds private state that the indexer owns. Migration 0008
creates these tables.

| Table                       | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `dashboard_finalized`       | Retained finalized height and hash evidence. Keyed by height text.     |
| `dashboard_scans`           | Bounded scan cursors and coverage for each domain and generation.      |
| `dashboard_scan_winners`    | Persisted winner enumeration pages within a scan.                      |
| `dashboard_metadata`        | Runtime metadata by genesis and state hash.                            |
| `dashboard_poll_difficulty` | Difficulty snapshots accepted from poll data with separate provenance. |

Migration 0008 also adds the `qblock_id` index on `blocks`, widens the
numeric columns, materializes `node_descriptors.node_name`, and adds the typed
descriptor name index.

Migration 0009 adds `dashboard_unavailable`. Each row records a verified absence
of historical nonce or difficulty data. Its key is `(domain, generation, height)`.
The other columns are `block_hash`, `enrichment_hash`, `reason`, `observed_at`,
and nullable `next_height`. Heights and generations use decimal text on both engines.
The marker stops automatic retries without marking the height covered.
Explicit reindexing deletes markers for the selected domains.

## Migration-tooling tables

Managed by the migrate command. Do not write to them directly.

| Table                   | Purpose                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `kysely_migration`      | Ledger of applied migrations (`name`, `timestamp`).                                                           |
| `kysely_migration_lock` | Advisory lock guarding concurrent migration runs. Postgres uses a session advisory lock for the same purpose. |
