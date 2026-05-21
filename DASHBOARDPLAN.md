# DASHBOARDPLAN.md — Indexing Miner Identities from Chain Remarks

## Audience

Dashboard / indexer engineers who need to surface per-miner identity and
hardware info (the v0.2 equivalent of v0.1 `nodes.json`) by reading the
substrate chain — no off-chain coordination required.

## What the chain carries

When an operator runs `quip-miner identify`, the client posts a signed
extrinsic to the runtime:

- **Preferred call**: `System.remark_with_event(remark: bytes)` — emits a
  `System.Remarked { sender, hash }` event so indexers can subscribe to
  the event stream instead of scanning every extrinsic call data field.
- **Fallback call**: `System.remark(remark: bytes)` — used when the
  runtime metadata doesn't expose `remark_with_event` (older FRAME
  versions). No event is emitted; indexers must scan extrinsic bodies.

The signed origin (`AccountId32`) is the canonical identity. The remark
body is canonical UTF-8 JSON (sorted keys, compact separators) matching:

```json
{
  "schema": "quip.node_descriptor.v1",
  "descriptor_version": 1,
  "node_name": "rig-01",
  "public_host": "rig-01.example.com",
  "public_port": 20049,
  "rpc_endpoints": ["ws://rig-01.example.com:9944"],
  "auto_mine": true,
  "log_level": "INFO",
  "runtime": {
    "python": "3.13.13",
    "quip_version": "0.2.0",
    "protocol_version": 2,
    "in_docker": true,
    "docker_image": "registry.gitlab.com/quip.network/quip-protocol/quip-network-node-cpu:abc1234"
  },
  "miners": {
    "cpu": { "kind": "CPU", "miner_id": "rig-01-CPU-1", "num_cpus": 2 },
    "dwave": {
      "kind": "QPU",
      "miner_id": "rig-01-QPU-DWAVE-1",
      "provider": "dwave",
      "solver": "Advantage2_system1",
      "daily_budget": "5m"
    }
  },
  "system_info": {
    "os": { "system": "Linux", "release": "5.15.0-176-generic", "machine": "x86_64" },
    "cpu": {
      "logical_cores": 32,
      "physical_cores": 16,
      "brand": "AMD Ryzen 9 5950X 16-Core Processor",
      "arch": "x86_64"
    },
    "memory_mb": 128693,
    "gpus": [
      {
        "index": 0,
        "vendor": "NVIDIA",
        "name": "NVIDIA RTX A4000",
        "memory_mb": 16376,
        "observed_utilization_pct": 0
      }
    ]
  }
}
```

Full schema is defined in `shared/system_info.py`
(`NodeDescriptor`/`SCHEMA_NAME = "quip.node_descriptor.v1"`). The shape
mirrors v0.1 `telemetry/nodes.json` exactly except for fields the
dashboard owns (`address`, `status`, `first_seen`, `last_seen`,
`last_heartbeat`, `ecdsa_public_key_hex`) — those are derived from the
indexer's own state, never self-asserted.

## Indexing strategy

### Path A — event subscription (preferred when `remark_with_event` is on the chain)

Subscribe to finalized blocks and filter `System.Remarked` events. The
sender's AccountId is the extrinsic origin (also exposed by the event
itself); the body is the corresponding `remark` argument.

```python
# substrate-interface
from substrateinterface import SubstrateInterface
import json

iface = SubstrateInterface(url="wss://validator-1.quip.network:9944")
for block_hash in iface.subscribe_block_headers(finalized_only=True):
    events = iface.get_events(block_hash=block_hash)
    for ev in events:
        if ev["event"]["module_id"] != "System":
            continue
        if ev["event"]["event_id"] != "Remarked":
            continue
        sender = ev["event"]["attributes"]["sender"]   # AccountId32 (SS58)
        body_hash = ev["event"]["attributes"]["hash"]  # blake2_256 of the remark
        # Pull the matching extrinsic to recover the raw bytes.
        block = iface.get_block(block_hash=block_hash)
        ext = block["extrinsics"][ev["extrinsic_idx"]]
        raw = ext.value["call"]["call_args"][0]["value"]  # 0x-prefixed hex
        try:
            payload = json.loads(bytes.fromhex(raw[2:]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if payload.get("schema") != "quip.node_descriptor.v1":
            continue   # not ours; some other tool also remarks here
        upsert_descriptor(sender, block_number, ev["extrinsic_idx"], payload)
```

### Path B — extrinsic scan (when only plain `remark` is available)

Same approach minus the event filter: walk every extrinsic in the
block, match `module="System"` and `function in {"remark", "remark_with_event"}`,
decode the first argument. Slower (every block carries non-remark
extrinsics) but works on any FRAME chain.

### Path C — historical backfill

On first startup the indexer needs to backfill before subscribing. Pick
the earliest block at which the identify extrinsic could have landed
(deployment date of the v0.2 runtime upgrade) and scan forward using
Path A or B. Persist a `last_indexed_block` checkpoint so restarts
resume in place.

## Storage model

Use a unique-per-account table; the latest valid descriptor wins.

```sql
CREATE TABLE node_descriptors (
  account_id      BYTEA PRIMARY KEY,            -- 32 bytes
  ss58_address    TEXT NOT NULL,                -- denormalized for UI
  block_number    BIGINT NOT NULL,
  extrinsic_index INT NOT NULL,
  block_hash      BYTEA NOT NULL,
  descriptor      JSONB NOT NULL,               -- the parsed payload
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_node_descriptors_block ON node_descriptors (block_number);
CREATE INDEX ix_node_descriptors_name  ON node_descriptors ((descriptor->>'node_name'));
```

Upsert rule: replace the row whenever
`(new.block_number, new.extrinsic_index) > (existing.block_number, existing.extrinsic_index)`.
Never merge fields across descriptors — an operator clearing a field
expects the omission to take effect.

## Field-by-field guidance

| Field                                | Use it for                                                         | Caveats                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `node_name`                          | Display label only                                                 | Self-asserted; not unique. Awards key off AccountId.                                               |
| `public_host`/`public_port`          | Show "where to reach this node"                                    | Self-asserted; verify via your own probe before linking.                                           |
| `rpc_endpoints`                      | Show advertised RPC URLs                                           | Don't forward traffic without your own allow-listing.                                              |
| `auto_mine`                          | Badge "auto-mining" vs "manual" in UI                              | Cosmetic.                                                                                          |
| `runtime.quip_version`               | Compatibility / version-skew dashboards                            | Trust as-is.                                                                                       |
| `runtime.protocol_version`           | Detect peers that need upgrading                                   | Mismatch ≠ malice; warn, don't reject.                                                             |
| `runtime.in_docker` / `docker_image` | Surface deployment topology                                        | Image tag is the operator's free-form string.                                                      |
| `miners.*`                           | Hardware breakdown per node (CPU/GPU/QPU bucket counts)            | `solver` is operator-asserted; cross-check against chain-side topology hash if you need authority. |
| `system_info`                        | Total network-capacity dashboards (RAM, GPU model histogram, etc.) | Unverifiable; a misconfigured miner could claim anything. Don't weight rewards by these values.    |

## Discarded payloads

Drop and log (do not partially apply) when:

- JSON parse fails.
- `schema` is missing or not `quip.node_descriptor.v1`.
- `descriptor_version` is not `1` (forward-compat: when newer versions
  ship, write a parallel handler rather than mutate this one).
- `node_name` is empty or > 64 UTF-8 bytes.
- `rpc_endpoints` has > 8 entries or any entry > 256 UTF-8 bytes.
- Any string value in the payload matches a known credential shape
  (DWAVE_API_KEY, AWS keys, sk-..., Bearer tokens, JWT-ish strings) —
  treat as misconfigured upload and refuse to display.

These bounds match what the miner client enforces in
`shared.system_info.validate_descriptor`; an indexer that mirrors them
will only accept payloads the client also considered well-formed.

## Awarding rewards

Use `AccountId` exclusively. `node_name` collisions are allowed and
expected (two different operators may legitimately name their nodes
"rig-01"). Award by signed origin, display by name.

## Update cadence

Operators run `quip-miner identify` ad hoc (e.g., after changing
hardware or `node_name`). There's no fixed interval. The dashboard
should treat "no fresh descriptor in N days" as expected, not a
liveness signal — use heartbeats / block authorship for liveness.

## Forward compatibility

When the runtime gains typed storage (`NodeDescriptors: AccountId =>
NodeDescriptor` per Phase 2 of the original plan), the indexer should:

1. Query the typed storage as the primary source: `state_getStorage("NodeDescriptors", [account])`.
2. Fall back to the remark scan for accounts not yet present in storage
   (operators who registered before the runtime upgrade).
3. Stop scanning remarks once the upgrade block is well in the past and
   all active miners have re-submitted via the typed extrinsic.

The on-wire JSON shape, field names, and bounds are intended to stay
stable across that migration — only the call envelope changes.

## Troubleshooting

| Symptom                                         | Likely cause                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `System.Remarked` event missing                 | Runtime is on older FRAME; use Path B (extrinsic scan).                                |
| Payload decodes but `schema` is wrong           | Another tool also uses `System.remark`; ignore non-matching schemas.                   |
| Descriptor shows but never updates              | Operator hasn't re-run `quip-miner identify` since last hardware change.               |
| Duplicate `node_name`s in dashboard             | Expected — names aren't unique. Display AccountId alongside.                           |
| Validation rejects post-decode                  | Operator's quip-miner pre-dates the field-bound enforcement; ask them to upgrade.      |
| `solver` field shows for one miner, not another | Suspicious value got dropped by the client-side scrub; operator should fix their TOML. |
