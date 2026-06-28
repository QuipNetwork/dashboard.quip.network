# DASHBOARDPLAN.md — Indexing Miner Identities from Chain Storage

## Audience

Dashboard / indexer engineers who need to surface per-miner identity and
hardware info (the v0.2 equivalent of v0.1 `nodes.json`) by reading the
substrate chain — no off-chain coordination required.

> **History (v0.1 → v0.2).** Identity used to be published as a
> `System.remark{,_with_event}` JSON blob (`quip.node_descriptor.v1`), and
> this indexer scanned every finalized block for it. quip-protocol-rs v0.2
> moved identity into a typed `MinerRegistry` pallet, so the indexer now
> reads a storage map instead of scanning extrinsics. The old remark
> pipeline (descriptor-worker, descriptor-validator, scan-remarks) is gone.

## What the chain carries

When an operator runs `quip-miner identify`, the client signs a
`MinerRegistry.set_descriptor` extrinsic. The runtime validates it and
stores a typed record in the `MinerRegistry.NodeDescriptors` storage map,
keyed by the signing `AccountId32`. Participation per qblock is signed
separately via `MinerRegistry.participate`.

The stored `NodeDescriptor` struct (schema V1, plus V2 which adds the
optional `runtime` block and `system_info` hardware survey) carries:

- `schema_version: u16` — `1` (identity only) or `2` (identity + `system_info`)
- `node_id`, `node_name` — `BoundedVec<u8>` UTF-8 byte strings
- `public_host: Option<...>`, `public_port: Option<u16>`
- `rpc_endpoints: Vec<...>`
- `auto_mine: bool`, `log_level: enum { Debug, Info, Warning, Error }`
- `miners: Vec<MinerSpec>` where `MinerSpec = { kind: MinerKind, label?, backend?, device_id? }`
  and `MinerKind ∈ { Cpu, Gpu, QpuDwave, QpuIbm, QpuIonq, QpuPasqal, Asic }`
- `payload_hash: H256`, `updated_at: BlockNumber`, `deposit: Balance`
- `runtime: Option<RuntimeInfo>` (V2 only):
  `{ python, quip_version, protocol_version: u32, in_docker: bool, docker_image? }`
- `system_info: Option<SystemInfo>` (V2 only):
  `os { system, release, machine }`, `cpu { logical_cores, physical_cores, brand, arch }`,
  `memory_mb`, `gpus: Vec<{ index, vendor, name, memory_mb?, utilization_pct? }>`

The signed origin (the storage key) is the canonical identity. The struct
definitions live in `quip-protocol-rs/pallets/miner-registry/src/lib.rs`.

Compared to the v0.1 JSON descriptor, the typed struct is narrower: it keeps
the `runtime` block (re-added to V2) and the optional `system_info` hardware
survey, but **drops** the rich per-miner economics (`provider` / `solver` /
`daily_budget` / per-miner CPU counts) — the on-chain `MinerSpec` carries
only `kind` / `label` / `backend` / `device_id`. The dashboard surfaces only
what the chain now carries.

## Indexing strategy

Descriptors are a storage map, not per-block events, so there is no scan and
no checkpoint. The substrate worker's chain-state poll reads the whole map
on a cadence — alongside `quantum_pow.Miners` — and upserts each entry:

```ts
// indexer/substrate-client.ts
const entries = await api.query.minerRegistry.nodeDescriptors.entries();
// each value.toJSON() → mapChainDescriptor(accountId, json)
```

`mapChainDescriptor` (exported, unit-tested) normalises the polkadot.js
`.toJSON()` view: `Bytes` fields arrive as `0x`-hex and are decoded to
UTF-8, enum variants are normalised case-insensitively, and `None` options
(null) drop out as absent optionals.

## Storage model

One row per account; the newest descriptor wins. Columns:

```
node_descriptors(
  account_id PRIMARY KEY,
  block_number,            -- on-chain updated_at height (upsert tie-breaker)
  payload_hash,            -- on-chain payload_hash
  block_timestamp,         -- unix seconds, indexer observe time (last seen)
  first_block_timestamp,   -- unix seconds, preserved across upserts (first seen)
  descriptor,              -- the decoded NodeDescriptor JSON
  observed_at              -- ISO 8601 indexer write time
)
```

Upsert rule: replace when `new.block_number > existing.block_number`. The
chain stores only the latest descriptor per account, so the poll naturally
converges. `first_block_timestamp` is preserved so the NodeInfo projection
can report "first observed" distinctly from "last observed". The chain
descriptor carries only an `updated_at` block number (not a wall-clock), so
both timestamps are stamped with the indexer's observe time.

## Field guidance

| Field                       | Use it for                               | Caveats                                                  |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `node_name`                 | Display label only                       | Self-asserted, not unique. Awards key off AccountId.     |
| `public_host`/`public_port` | "Where to reach this node"               | Self-asserted; verify via your own probe before linking. |
| `rpc_endpoints`             | Advertised RPC URLs                      | Don't forward traffic without your own allow-listing.    |
| `auto_mine`                 | "auto-mine" badge                        | Cosmetic.                                                |
| `miners[].kind/label`       | Hardware breakdown (CPU/GPU/QPU buckets) | Operator-asserted.                                       |
| `runtime` (V2)              | Version-skew dashboards (quip/protocol)  | Trust as-is; mismatch ≠ malice.                          |
| `system_info` (V2)          | Network-capacity dashboards (RAM, GPUs)  | Unverifiable; never weight rewards by these values.      |

## Awarding rewards

Use `AccountId` exclusively. `node_name` collisions are allowed and expected.
Award by signed origin (the storage key), display by name.

## Liveness

There is no chain heartbeat. Treat "descriptor present" as "registered", not
"online" — use block authorship (`validator_authorship`) for liveness.

## Other v0.2 chain surfaces (wired)

The pallets expose more than identity; the dashboard now reads these too:

- **qblock IDs** — the `quantum_pow.BlockWinner` event carries a monotonic
  `qblock_id`, persisted on `blocks.qblock_id` and shown as the authoritative
  "Solution #" in the Recent Solutions table. `quantum_pow.QBlockCount` is the
  network-wide count (the global "solution number"), surfaced on
  `chain_head.winning_solutions_count`.
- **Per-topology difficulty** — `QuantumPowApi::mineable_topologies()` +
  `difficulty_for(hash)` + `topology_meta(hash)`; difficulty is keyed by
  topology hash (`quantum_pow.Difficulties`) with a mineable whitelist
  (`quantum_pow.MineableTopologies`). The worker snapshots this each poll into
  a `mineable_topologies` meta row; the Chain tab renders it as the Mineable
  Topologies panel.
- **Participation per qblock** — `MinerRegistryApi::participant_count_by_qblock`
  for the in-flight qblock (`QBlockCount + 1`), stored on
  `chain_head.current_qblock_participants` and shown next to the Mining Problem
  indicator. (The full `participants_by_qblock` list is available for a future
  per-miner participation view.)
