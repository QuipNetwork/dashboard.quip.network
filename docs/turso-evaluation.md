# Turso evaluation

Embedded Turso 0.7.2 passed the executed qualification cases on x86_64.
This result does not cover arm64.
Postgres remains selectable through SQLx.
Turso experimental Postgres protocol is not the production option.

## Versions

crates.io reports `max_stable_version` 0.7.2 for the `turso` crate on 2026-09-16.
The newest published crate is `0.8.0-pre.11`.
This suite locks 0.7.2.

| Item            | Value                                   |
| --------------- | --------------------------------------- |
| Turso crate     | 0.7.2 from crates.io                    |
| rustc           | 1.98.1 (48a229cea 2026-09-01)           |
| cargo           | 1.98.1 (797e8a9bc 2026-08-05)           |
| Host            | Debian 12, Linux 6.1.0-52-amd64, x86_64 |
| Process uid     | 1000                                    |
| Docker server   | 29.7.2                                  |
| Container image | `python:3.12-slim-bookworm` (glibc)     |
| Crate path      | `tools/turso-gate`                      |

The suite opens Turso with `Builder::new_local`.
It does not enable experimental multi-process WAL or MVCC.
The qualifier pins `default-features = false` on the `turso` dependency, which
removes the unused `mimalloc` allocator and FTS features.
The dashboard store does not use full-text search.

## Commands

Run these commands from `tools/turso-gate`.
Set `CARGO_BUILD_JOBS=2`.
Set `CARGO_TARGET_DIR` to `tools/turso-gate/target`.

```sh
cargo fmt -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked -- --nocapture
```

## Case results

All 18 tests passed on this host.

| Case                         | Result         | Evidence                                                                                                                                                                     |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit then reopen           | Pass           | Cursor text `42` survived a new `Builder::new_local`                                                                                                                         |
| Rollback of block and cursor | Pass           | Rolled-back block 2 and cursor `2` were absent. Block 1 remained                                                                                                             |
| Composite-key UPSERT         | Pass           | `(qblock_id, account)` updated kind, budget, and block number                                                                                                                |
| Exact u256 decimal text      | Pass           | `u256::MAX` stored and read as text. `typeof` returned `text`                                                                                                                |
| JSON extraction              | Pass           | `json_extract` and `->>` returned `alice`                                                                                                                                    |
| Predecessor durations        | Pass           | Blocks `(1,100)`, `(2,112)`, `(3,130)` and `since=112` returned 12 and 18                                                                                                    |
| `lag()`                      | Unsupported    | Engine error: `Parse error: no such function: lag`                                                                                                                           |
| One writer and four readers  | Pass           | Four connections from one handle read count 20 and page `11,12,13`                                                                                                           |
| WAL checkpoint and reopen    | Pass with note | Data survived reopen. WAL size stayed 45352 bytes                                                                                                                            |
| SIGKILL before commit        | Pass           | After SIGKILL, cursor was absent and block count was 0                                                                                                                       |
| SIGKILL after commit         | Pass           | After SIGKILL, cursor was `42` and block count was 1                                                                                                                         |
| Permission error, non-root   | Pass           | Open failed with `I/O error (open): permission denied`. Cursor stayed `1`. Write succeeded after restore                                                                     |
| Bounded RLIMIT disk-full     | Pass           | Child hit `SIGXFSZ` under `ulimit -f 256`. Cursor stayed `1`. A later small write succeeded                                                                                  |
| Real ENOSPC, tmpfs in Docker | Pass           | 4 MiB tmpfs full: `I/O error (pwritev): no storage space`. The test removes only a separate filler file. Block `1` survives and block `42` commits. Both remain after reopen |
| Default I/O                  | Pass           | `PRAGMA journal_mode=WAL` returned `wal` without privileged flags                                                                                                            |
| Explicit `syscall` VFS       | Pass           | Reopen with `with_io("syscall")` kept cursor `3`                                                                                                                             |
| Container restrictions       | Pass           | `python:3.12-slim-bookworm`, uid 1000, `no-new-privileges`, isolated network. Phase `after-commit` persisted                                                                 |
| Database selection           | Pass           | An empty address selects embedded Turso. `postgres://` and `postgresql://` select SQLx Postgres. Other nonempty addresses are errors                                         |

## Query change

Current Postgres SQL uses `lag(timestamp)` over `qblock_id`.
Turso 0.7.2 does not provide `lag()`.

The gate query uses an indexed predecessor lookup:

```sql
SELECT b.qblock AS qblock, (b.ts - pred.ts) AS duration
FROM blocks AS b
INNER JOIN blocks AS pred
  ON pred.qblock = (
    SELECT MAX(p.qblock) FROM blocks AS p WHERE p.qblock < b.qblock
  )
WHERE b.ts >= ?1
  AND (b.ts - pred.ts) > 0
ORDER BY b.qblock ASC
```

The predecessor outside the window counts.
The first block ever has no duration.

## Performance and memory

A qualification run wrote 1000 block and cursor rows in one transaction in 721 ms.
`/proc/self/status` `VmRSS` moved from 9828 KiB to 39608 KiB in that test process.
These figures are a debug-profile smoke measurement, not a production soak.

## Limits

- Tests ran on x86_64 only. Do not treat this as an arm64 result.
- `PRAGMA wal_checkpoint` did not shrink the WAL file.
- The RLIMIT disk-full case used `RLIMIT_FSIZE` in a child. The kernel sent `SIGXFSZ`. This is disposable local storage, not a host volume.
- The real ENOSPC case used a 4 MiB tmpfs in an ephemeral Docker container. Docker removes the container at exit. Its tmpfs mount isolates the fill from host storage.
- Permission case used mode `0444` on the database files. Directory mode `0555` alone did not block writes to existing files.
- This crate does not open Postgres. SQLx Postgres remains the real option from the specification.
- Default I/O worked in an unprivileged container. This suite does not name the default VFS beyond the successful `syscall` case.

## Recommendation

The listed cases pass the engine gate on x86_64.
Keep the product default on embedded Turso only after store wiring uses this query and WAL model.
Keep Postgres selectable through `DATABASE_URL`.
Repeat the suite on arm64 before any arm64 default claim.
