# Database Schema

The dashboard stores indexer-derived telemetry in a single database, supported on
two backends — **SQLite** (local / single-node deployments) and **PostgreSQL**
(production). The schema is defined once, dialect-aware, in `migrations/` and
applied with the dedicated migrate command:

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

These conventions explain the per-dialect type choices in the column tables
below.

| Convention | SQLite | PostgreSQL | Notes |
| --- | --- | --- | --- |
| **u64/u128 as string** | `TEXT` | `NUMERIC` | Block numbers, slots, balances, nonces, and nanosecond timestamps exceed `INTEGER`'s 8-byte signed range or need exact decimal precision; stored as strings and compared with `CAST(... AS INTEGER)` on SQLite. |
| **unix seconds** | `INTEGER` | `BIGINT` | Wall-clock timestamps as seconds since the epoch. |
| **big counters** | `INTEGER` | `BIGINT` | Monotonic counts and milli-unit values that can grow past 32 bits. |
| **floats** | `REAL` | `DOUBLE PRECISION` | Energy / diversity / mining-time measurements. |
| **booleans** | `INTEGER` (0/1) | `BOOLEAN` | SQLite has no native boolean; flags are stored as 0/1. |
| **ISO timestamps** | `TEXT` | `TIMESTAMPTZ` | `updated_at` / `observed_at` style audit columns, ISO-8601. |
| **JSON** | `TEXT` | `JSONB` | Structured blobs (`miners`, `descriptor`). |
| **milli-units** | `INTEGER` | `BIGINT` | Energy/diversity/threshold scaled ×1000 to keep integers; the UI divides by 1000 at display time. |

---

## `blocks`

Won proof-of-work blocks. The substrate worker is the sole writer; rows are
inserted once (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`) and only
`finalized` is later updated.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `block_hash` | TEXT | TEXT | PK | Dashboard primary key — the PoW block's hash. |
| `substrate_block_number` | TEXT | NUMERIC | no | Substrate block height (u64-as-string). |
| `substrate_block_hash` | TEXT | TEXT | no | Substrate block hash. |
| `substrate_parent_hash` | TEXT | TEXT | no | Parent block hash. |
| `timestamp` | INTEGER | BIGINT | no | Block production time (unix seconds). |
| `miner_id` | TEXT | TEXT | no | SS58 account that won the block. |
| `energy` | REAL | DOUBLE PRECISION | no | Energy of the winning solution. |
| `diversity` | REAL | DOUBLE PRECISION | no | Diversity of the winning solution. |
| `num_valid_solutions` | INTEGER | INTEGER | no | Count of valid solutions in the block. |
| `mining_time` | REAL | DOUBLE PRECISION | no | Seconds spent mining this block. |
| `reward` | TEXT | NUMERIC | no | Block reward (planck, u128-as-string). |
| `nonce` | TEXT | NUMERIC | no | Winning nonce (u64-as-string). |
| `num_nodes` | INTEGER | INTEGER | no | Problem graph node count. |
| `num_edges` | INTEGER | INTEGER | no | Problem graph edge count. |
| `difficulty_energy` | REAL | DOUBLE PRECISION | no | Energy threshold in force for this block. |
| `min_diversity` | REAL | DOUBLE PRECISION | no | Diversity requirement in force. |
| `min_solutions` | INTEGER | INTEGER | no | Minimum solutions requirement in force. |
| `finalized` | INTEGER (0/1) | BOOLEAN | no | Whether the block is finalized; flipped monotonically 0→1. |

Indexes: `(substrate_block_number DESC)`, `(miner_id, substrate_block_number DESC)`,
`(timestamp DESC)`.

## `miner_hardware`

Per-miner hardware inventory. In v0.3 only one row per account is written
(`source = 'self'`).

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `account_id` | TEXT | TEXT | PK | Miner SS58 account. |
| `node_id` | TEXT | TEXT | no | Reporting node identifier. |
| `miners` | TEXT | JSONB | no | JSON array of hardware entries (type, count, etc.). |
| `primary_type` | TEXT | TEXT | no | Dominant miner backend (CPU / CUDA / METAL / MODAL / QPU). |
| `source` | TEXT | TEXT | no | Origin of the row (e.g. `self`). |
| `observed_at` | TEXT | TIMESTAMPTZ | no | When the inventory was observed. |

## `meta`

Generic key/value store, avoiding dedicated single-value tables.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `key` | TEXT | TEXT | PK | Meta key. |
| `value` | TEXT | TEXT | yes | Opaque value (string or JSON text). |

Known keys: `self_address` (the local validator's SS58), `indexer_observability`
(JSON health/minerStats blob), `descriptor_checkpoint` (last block scanned for
node descriptors), `mining_checkpoint:<ss58>` (per-miner submission cursor).

## `chain_head`

Singleton (`id = 1`) snapshot of the chain head and runtime.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | INTEGER | PK | Always 1 (`CHECK (id = 1)`). |
| `best_block_number` | TEXT | NUMERIC | no | Best (non-finalized) block height. |
| `best_block_hash` | TEXT | TEXT | no | Best block hash. |
| `finalized_block_number` | TEXT | NUMERIC | no | Finalized block height. |
| `finalized_block_hash` | TEXT | TEXT | no | Finalized block hash. |
| `finality_lag` | INTEGER | INTEGER | no | best − finalized height. |
| `winning_solutions_count` | INTEGER | BIGINT | yes | Length of `quantum_pow.WinningSolutions`; `count + 1` is the in-flight problem. Null on pre-v0.2 chains / before first read. |
| `spec_name` | TEXT | TEXT | no | Runtime spec name. |
| `spec_version` | INTEGER | INTEGER | no | Runtime spec version. |
| `transaction_version` | INTEGER | INTEGER | no | Runtime transaction version. |
| `impl_name` | TEXT | TEXT | no | Runtime implementation name. |
| `last_runtime_upgrade` | TEXT | NUMERIC | yes | Block of the last runtime upgrade (u64-as-string). |
| `updated_at` | TEXT | TIMESTAMPTZ | no | When this snapshot was written. |

## `babe_epochs`

BABE epoch state; `is_current` marks the active epoch.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `epoch_index` | INTEGER | INTEGER | PK | Epoch index. |
| `current_slot` | TEXT | NUMERIC | no | Current slot number (u64-as-string). |
| `epoch_start_slot` | TEXT | NUMERIC | no | First slot of the epoch. |
| `slots_per_epoch` | INTEGER | INTEGER | no | Slot count per epoch. |
| `current_slot_in_epoch` | INTEGER | INTEGER | no | Offset of the current slot within the epoch. |
| `authority_count` | INTEGER | INTEGER | no | Number of authorities for the epoch. |
| `is_current` | INTEGER (0/1) | BOOLEAN | no | Whether this is the active epoch. |
| `updated_at` | TEXT | TIMESTAMPTZ | no | When the row was written. |

Indexes: `(is_current)` — partial (`WHERE is_current`) on PostgreSQL.

## `babe_authorities`

Per-epoch authority set. Composite primary key `(account_id, epoch_index)`.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `account_id` | TEXT | TEXT | PK | Authority SS58 account. |
| `epoch_index` | INTEGER | INTEGER | PK | Epoch this authority entry belongs to. |
| `display_name` | TEXT | TEXT | yes | Optional human-readable name. |
| `is_active` | INTEGER (0/1) | BOOLEAN | no | Whether the authority is active in the epoch. |
| `updated_at` | TEXT | TIMESTAMPTZ | no | When the row was written. |

Indexes: `(epoch_index, is_active)`.

## `chain_miners`

On-chain miner registry stats.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `account_id` | TEXT | TEXT | PK | Miner SS58 account. |
| `deposit` | TEXT | NUMERIC | no | Registration deposit (planck, u128-as-string). |
| `proofs_submitted` | TEXT | NUMERIC | no | Lifetime proofs submitted. |
| `proofs_won` | TEXT | NUMERIC | no | Lifetime proofs won. |
| `rewards_earned` | TEXT | NUMERIC | no | Lifetime rewards (planck). |
| `updated_at` | TEXT | TIMESTAMPTZ | no | When the row was written. |

## `difficulty_history`

Append-only difficulty snapshots, keyed by the block at which they were observed.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `observed_at_block` | TEXT | NUMERIC | PK | Block height of the snapshot (u64-as-string). |
| `difficulty_energy` | REAL | DOUBLE PRECISION | no | Energy threshold at that block. |
| `min_diversity` | REAL | DOUBLE PRECISION | no | Diversity requirement at that block. |
| `min_solutions` | INTEGER | INTEGER | no | Minimum solutions requirement at that block. |
| `observed_at` | TEXT | TIMESTAMPTZ | no | Wall-clock time of observation. |

Indexes: `(observed_at DESC)`.

## `validator_authorship`

Per-validator authorship counters, one row per observed author.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `account_id` | TEXT | TEXT | PK | Validator SS58 account. |
| `blocks_authored` | INTEGER | BIGINT | no | Total blocks authored (default 0). |
| `blocks_authored_with_pow` | INTEGER | BIGINT | no | Blocks authored that carried a PoW seal (default 0). |
| `last_authored_block` | TEXT | NUMERIC | no | Height of the most recent authored block. |
| `last_authored_at` | TEXT | TIMESTAMPTZ | no | ISO-8601 time of the last authored block; backs the online/offline window. |

Indexes: `(blocks_authored DESC)`.

## `node_descriptors`

Per-account chain-signed identity, sourced from `System.remark_with_event`
extrinsics by the descriptor worker. `(block_number, extrinsic_index)` is the
upsert tie-breaker so a later descriptor in the same block wins.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `account_id` | TEXT | TEXT | PK | Account the descriptor belongs to. |
| `block_number` | TEXT | NUMERIC | no | Block of the descriptor extrinsic (u64-as-string). |
| `block_hash` | TEXT | TEXT | no | Hash of that block. |
| `extrinsic_index` | INTEGER | INTEGER | no | Index of the extrinsic within the block (tie-breaker). |
| `block_timestamp` | INTEGER | BIGINT | no | Time of the descriptor block (unix seconds). |
| `first_block_timestamp` | INTEGER | BIGINT | no | Time first observed; preserved across upserts ("first seen"). |
| `descriptor` | TEXT | JSONB | no | The signed descriptor payload (JSON). |
| `observed_at` | TEXT | TIMESTAMPTZ | no | When the row was written. |

Indexes: `(block_number DESC)`.

## `mining_submissions`

Per-submission summaries polled from the local miner's
`/api/v1/mining/attempts?solution_number=N` endpoint. Composite primary key
`(miner_id, solution_number)` so polling multiple miners never collides.
`solution_number` is the global chain solution index
(`count(WinningSolutions) + 1`), durable across restarts.

| Column | SQLite | PostgreSQL | Null | Description |
| --- | --- | --- | --- | --- |
| `miner_id` | TEXT | TEXT | PK | Polled miner SS58 account. |
| `solution_number` | INTEGER | BIGINT | PK | Global chain solution number. |
| `ts_ns` | TEXT | NUMERIC | no | Submission timestamp in nanoseconds (u128-as-string). |
| `energy_milli` | INTEGER | BIGINT | no | Solution energy ×1000. |
| `diversity_milli` | INTEGER | BIGINT | no | Solution diversity ×1000. |
| `threshold_milli` | INTEGER | BIGINT | no | Energy threshold ×1000. |
| `last_proof_block_hash` | TEXT | TEXT | no | Block hash of the last proof in the attempt. |
| `extrinsic_hash` | TEXT | TEXT | yes | Submission extrinsic hash; null until it lands on chain. |
| `chain_block_hash` | TEXT | TEXT | yes | Winning block hash; null for non-winning / not-yet-landed. |
| `chain_block_number` | TEXT | NUMERIC | yes | Winning block height (u64-as-string); null when not a winner. |
| `pow_sequence` | INTEGER | BIGINT | yes | On-chain `proofs_submitted` sequence for non-winning submissions; null for winners and pre-MR!105 miners. |
| `outcome` | TEXT | TEXT | no | Submission outcome (e.g. won / submitted). |
| `attempt_count` | INTEGER | INTEGER | no | Number of attempts in the submission. |
| `best_energy_milli` | INTEGER | BIGINT | no | Best energy seen across attempts ×1000. |
| `num_valid` | INTEGER | INTEGER | no | Count of valid solutions (default 0). |
| `miner_type` | TEXT | TEXT | no | Backend that produced the submission (CPU / CUDA / METAL / MODAL / QPU); empty if unreported. |
| `qpu_access_time_us` | INTEGER | BIGINT | no | Summed D-Wave QPU access time across iterations (µs); 0 for non-QPU rows (default 0). |
| `observed_at` | TEXT | TIMESTAMPTZ | no | When the row was written. |

Indexes: `(miner_id, solution_number DESC)`.

---

## Migration-tooling tables

Managed by Kysely; do not write to them directly.

| Table | Purpose |
| --- | --- |
| `kysely_migration` | Ledger of applied migrations (`name`, `timestamp`). |
| `kysely_migration_lock` | Advisory lock row guarding concurrent migration runs. |
