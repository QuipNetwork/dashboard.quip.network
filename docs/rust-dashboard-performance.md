# Rust dashboard performance benchmark

This document describes the matching-workload benchmark for the Rust dashboard
rewrite, Task 11 of the plan. It records the harness, the measurement method,
and the current evidence state. No result is declared for a measurement that
did not happen.

## Scope

The benchmark compares the current TypeScript reference with the new Rust
system. Both sides replay the same recorded inputs and the same HTTP
schedule, which makes the comparison matched. The phases are cold start,
live steady state, and historical backfill, each measured on its own.

The benchmark harness lives in `scripts/benchmark/`. The runner is
`scripts/benchmark-dashboard.sh`.

## Recorded inputs

The chain fixture records a real captured final block. The provenance file
lists the upstream remote procedure calls and their response byte sizes:
chain_getFinalizedHead, chain_getBlock, state_getRuntimeVersion,
state_getMetadata, state_getStorage, chain_getBlockHash, and
state_getStorageHash. The miner fixture records the miner REST rules from the
seed. These fixtures are the recorded input unit for both sides.

The workload profile, `scripts/benchmark/workload.mjs`, turns the recorded
provenance and the seed rules into one consistent workload profile. The
validator upstream comparison uses the chain-provenance method calls only.
The miner REST rules are local HTTP requests to the miner and are recorded
separately, not counted as validator upstream calls. The current chain-only
baseline sums to 7 calls and 381,240 upstream response bytes for one input
unit. It also records 10 separate miner REST rules.

The schedule, `scripts/benchmark/schedule.mjs`, turns the contract manifest
into a deterministic HTTP schedule. A fixed seed keeps a given manifest, rate,
and duration byte-identical across runs. Both sides replay the same schedule.

## Measurement

The sampler, `scripts/benchmark/sampler.py`, reads the running containers at a
fixed interval. The interval and duration must be positive finite numbers.
It records two memory values, labelled by what was actually read:

- `{container}_workingSetBytes`: the Docker working-set memory from
  MemoryStats. This is not the same as resident memory.
- `{container}_rssBytes`: the true resident process memory from the stats
  map when the runtime exposes it, otherwise unavailable.

The working set is never recorded as RSS. True RSS is recorded separately and
marked unavailable when a runtime does not expose it, so the reduction can
distinguish an absent RSS value from a real zero.

The sampler also records CPU usage per container and any health and progress
endpoint a system exposes. It writes one record per sample and flushes after
each interval, so a long soak shows progress and partial output survives an
interruption. A container that is not running produces null records.

The analyzer, `scripts/benchmark/analyze.py`, reduces the raw samples and the
observed upstream totals into the assertion record. Every assertion comes from
measured data or from the recorded workload. None is hard-coded.

## Evidence the comparison must supply

An assertion passes only when its supporting evidence was measured. The
analyzer and validator treat missing, invalid, non-finite, or negative data
as failure. A measured real zero is a valid value. The absence of a
measurement is never treated as zero, and parity, admitted work, silent
stalls, and upstream reductions are never inferred from absence. Which
evidence each assertion requires:

| Assertion | Evidence required |
| --- | --- |
| API and indexed-data parity | An explicit `parity: true` in the observed upstream evidence. A missing or false parity flag fails. |
| Max admitted work | A progress field containing the admitted-work value. A real zero passes, and no field fails. |
| Upstream calls and bytes | Observed call and byte totals plus a recorded baseline. An absent or nonpositive baseline fails. |
| Steady combined-image RSS | A measured resident-memory value, or the working-set value with true RSS marked unavailable. |
| Steady combined-image CPU | A measured CPU fraction. A real zero passes. |
| Silent indexing stalls | A stall indicator field. No field fails, because zero is only claimable when measured. |

The observed upstream evidence must name an explicit baseline group and
candidate group in the result meta block. This is the Task 11 matched-baseline
contract: a reduction comparison without a baseline group cannot be
validated.

### The actual recorder

The current actual recorder provides raw outside counts through its external
metrics. The Rust app provides a health endpoint. Neither the recorder nor the
app yet exposes the admitted-work value, the silent-stall indicator, or the
parity decision over HTTP, so those assertions stay unmeasured until the
system publishes them.

## Validation

The validator, `scripts/benchmark/validator.py`, checks a result file against
the Task 11 assertions. It does not trust a `passed: true` boolean by itself:
it re-checks every observed value against the plan's fixed limit and requires
the explicit baseline and candidate groups. A forged `passed: true` on an
over-budget observation fails. It rejects a run with no measurement
evidence and a malformed result file. It enforces fixed upper caps on the
admitted-work, RSS, CPU, upstream, and stall limits. A caller cannot lower a
limit to force a pass.

## Task 11 assertions

| Assertion | Target |
| --- | --- |
| API and indexed-data parity | exact logical match with recorded responses |
| Max admitted work | at most 64 |
| Upstream calls and bytes | at most 50 percent of the recorded baseline |
| Steady combined-image RSS | below 512 MiB |
| Steady combined-image CPU | below 20 percent of one core |
| Silent indexing stalls | zero |

## How to run

Generate the schedule and workload:

```sh
./scripts/benchmark-dashboard.sh schedule --rate 5 --duration 30
./scripts/benchmark-dashboard.sh workload
```

Print the recorded upstream baseline:

```sh
./scripts/benchmark-dashboard.sh recorded-upstream
```

Sample the running baseline and new images:

```sh
./scripts/benchmark-dashboard.sh sample --baseline NAME --new NAME \
  --interval 2 --duration 30 --out build/samples.jsonl
```

Reduce the samples and check the result:

```sh
./scripts/benchmark-dashboard.sh analyze \
  --samples build/samples.jsonl --workload build/workload.json \
  --baseline '["NAME"]' --candidate '["NAME"]' \
  --observed-upstream '{"calls":N,"responseBytes":N,"parity":true}'
./scripts/benchmark-dashboard.sh validate build/result.json
```

Run the harness self-verification:

```sh
./scripts/benchmark-dashboard.sh test
```

Run soak sampling for a requested duration:

```sh
./scripts/benchmark-dashboard.sh soak --baseline NAME --new NAME --hours 24
```

## Soak analysis

The soak compares the final six hours of RSS and outstanding work with the
preceding six hours. The sampler records the sample interval, hardware, chain
size, and cache state when that data is available. Report any growth with its
profile. A six-hour or twenty-four-hour soak is a long job. The runner samples
for the exact requested duration and does not assume a result.

## Current evidence state

The Rust combined image exists and its runtime completed. The harness is
complete and self-verified. An actual comparison and a soak have not been run,
so no comparison result and no soak result is claimed.

The chain-live provenance records a valid final block at height 205970 with 7
remote procedure calls and a recorded time of 0.423 seconds. The recorded
upstream baseline for one input unit is 7 validator calls and 381,240 response
bytes, plus 10 miner REST rules.

No assertion result is declared for the Rust system. The harness produces a
failing assertion record when a run violates a target, and it fails when the
required evidence is missing, so a future run is judged from its own data.

## Gaps

The system does not yet publish the admitted-work value, the silent-stall
indicator, or an explicit parity decision over HTTP, so the admitted-work,
stall, and parity assertions stay unmeasured until those fields exist. The
analyzer reads whatever progress and health fields the system publishes. The
exact key names must match what the system emits.

The image must include Caddy and syslog in the combined-image RSS and CPU
totals. The sampler reads the whole-container stats of the running image, so
the totals include every process in the container once the combined image is
provided.
