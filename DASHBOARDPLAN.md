# DASHBOARDPLAN.md - Registry-Based Miner Identity Indexing

## General Idea

Goals are:

1. `quip-miner` in isolation should not require an indexer.
2. The indexer should do less work where possible and should not need to query both the miner and the chain for the same data. Only one should be needed.

A consequence is that the dashboard stays less complicated: it should be limited to talking with the indexer, and the indexer should provide all necessary dashboard data. The chain should not compute aggregate statistics; aggregate statistics remain the indexer's job.

## Descriptor Source

Miner identity now comes from `MinerRegistry.NodeDescriptors`, not `System.remark` or `System.remark_with_event`.

`quip-miner identify` submits a typed `MinerRegistry.set_descriptor` extrinsic. The runtime validates the compact `quip.node_descriptor.v1` schema before writing storage, so the dashboard no longer parses or rejects arbitrary JSON remark payloads.

The archived remark-based design is kept in `DASHBOARDPLAN_REMARK_OLD.md` for historical context only.

## Indexer Flow

1. The descriptor worker follows finalized substrate block numbers using its existing checkpoint.
2. For each finalized block, it reads the `MinerRegistry.NodeDescriptors` storage map at that block hash.
3. Each storage value includes its own `updated_at` block number. The indexer uses that block as descriptor provenance.
4. The indexer fetches the `updated_at` block hash and timestamp.
5. The compact runtime descriptor is projected into the existing dashboard `NodeDescriptor` JSON shape.
6. The row is upserted into `node_descriptors` by `account_id`.

No dashboard database migration is required. The existing table remains useful:

- `account_id` is the storage map key.
- `block_number` is the descriptor's `updated_at`.
- `block_hash` and `block_timestamp` are resolved from `updated_at`.
- `extrinsic_index` is set to `0` because registry snapshots have no extrinsic-position provenance.
- `descriptor` keeps the projected dashboard JSON shape.

## Cursor Consideration

`MinerRegistry.NodeDescriptors` map keys are good for metadata-backed prefix queries, but not naturally ordered for numeric cursor APIs. The current descriptor worker therefore exposes a bounded runtime path by scanning finalized block numbers and materializing the active descriptor set at each block, filtering through DB upsert ordering by `updated_at`.

This is acceptable for the current active-job and active-miner set, but should be revisited if the registry grows large or if clients need ordered descriptor history. A future runtime API or maintained descriptor-update index could provide direct numeric pagination.

## Descriptor Projection

The runtime stores compact bounded fields:

- `schema_version`
- `node_id`
- `node_name`
- `public_host`
- `public_port`
- `rpc_endpoints`
- `auto_mine`
- `log_level`
- `miners`
- `payload_hash`
- `updated_at`
- `deposit`

The dashboard projects only the fields it can display today:

- `schema = "quip.node_descriptor.v1"`
- `descriptorVersion = 1`
- `nodeName`
- `publicHost`
- `publicPort`
- `rpcEndpoints`
- `autoMine`
- `logLevel`
- `miners`

Rich local fields such as Python version, Docker image, OS, CPU brand, memory, and GPU model are not present in the compact on-chain descriptor and remain optional in the dashboard types.

## QBlock Source

The dashboard keeps the existing `chain_head.winning_solutions_count` column and `winningSolutionsCount` API field for compatibility, but the preferred source is now `quantum_pow.LatestQBlockId`.

This field is the latest monotonic qblock ordinal and equals the number of accepted winning solutions. The current in-flight problem id remains `LatestQBlockId + 1`. Older v0.2 runtimes can still fall back to counting `WinningSolutions`.
