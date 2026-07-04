# Sync-Aware Indexer Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause the indexer's heavy pipeline work (backfill dispatch, reconciler ticks, snapshot polls) while the connected validator reports major sync, and surface the syncing state in logs and the dashboard SyncIndicator.

**Architecture:** A new `SyncGate` `ConnectionStream` polls `system_health`/`system_syncState` with hysteresis and exposes `gated(): boolean` plus a `resumed$` signal. Three existing components consult the gate at their throttle points (queue `tryPull`, `Reconciler.tick`, `SnapshotScheduler` polls) — no lifecycle changes, all pipeline state (queues, coverage, walker plans) survives the pause. The gate publishes `nodeSyncing` fields into `IndexerObservability`, which already flows through the tip worker's flush → `/api/telemetry` → the frontend telemetry store.

**Tech Stack:** TypeScript (Bun workspaces), rxjs 7, `@polkadot/api` (isolated to `apps/indexer/clients/substrate-client/`), `bun:test`, React + Zustand frontend.

**Design spec:** `docs/superpowers/specs/2026-07-04-sync-aware-indexer-gating-design.md`

## Global Constraints

- Every new file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Block heights cross module boundaries as **u64-as-string**; `number` only inside the pipeline where existing code already uses it.
- `@polkadot/*` is imported ONLY inside `apps/indexer/clients/substrate-client/` (build enforces `verify:no-polkadot-in-bundle`).
- Poll cadence: **5s while syncing, 30s once synced**. Hysteresis: gate opens only after **2 consecutive** `isSyncing: false` polls; closes **immediately** on the first `isSyncing: true` poll.
- Log transitions with the `[indexer/substrate]` prefix, exactly: `validator is syncing (406,173/512,000) — pausing indexing` / `validator synced — resuming indexing` (parenthetical omitted when progress is unknown).
- `getSyncState` failure ≠ syncing: on RPC error the gate keeps its last state; warn on repeated failures.
- Tests use `bun:test` (`describe/test/expect`); run from the repo root: `bun test <path>`.
- Format touched files with `bunx prettier --write <files>` before each commit.
- Commit messages: imperative mood, ≤72-char subject, **no Co-Authored-By or other attribution trailers**.
- Typecheck a workspace with `bun run --filter @quip/<name> typecheck` (names: shared, core, indexer, frontend, server).

---

### Task 1: Observability fields — `nodeSyncing` + sync progress

**Files:**
- Modify: `packages/shared/telemetry/response.ts` (inside `IndexerObservability`, after the `chainConnected` field, ~line 47)
- Modify: `apps/indexer/core/state.ts` (initial observability object + `load()`)
- Test: `apps/indexer/core/state.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `IndexerObservability.nodeSyncing?: boolean`, `IndexerObservability.nodeSyncCurrentBlock?: string | null`, `IndexerObservability.nodeSyncHighestBlock?: string | null`. Task 3's SyncGate writes them; Task 8's frontend reads them.

- [ ] **Step 1: Write the failing test**

Append to `apps/indexer/core/state.test.ts` (reuse the file's existing imports of `IndexerState` and the in-memory adapter; add missing ones following the file's current import style):

```ts
test("load() resets sync-gate fields like chainConnected", async () => {
  const db = await newInMemoryAdapter();
  await db.setIndexerObservability({
    chainHeadFromNode: "100",
    lastStatusFetchAt: new Date().toISOString(),
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: true,
    minerStats: null,
    nodeSyncing: true,
    nodeSyncCurrentBlock: "406173",
    nodeSyncHighestBlock: "512000",
  });
  const state = new IndexerState(db);
  await state.load();
  expect(state.observability.nodeSyncing).toBe(false);
  expect(state.observability.nodeSyncCurrentBlock).toBeNull();
  expect(state.observability.nodeSyncHighestBlock).toBeNull();
  await db.disconnect();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/indexer/core/state.test.ts`
Expected: FAIL — TypeScript error (`nodeSyncing` does not exist on `IndexerObservability`) or `expect(undefined).toBe(false)` assertion failure.

- [ ] **Step 3: Add the fields**

In `packages/shared/telemetry/response.ts`, inside `IndexerObservability` directly after the `chainConnected: boolean;` line:

```ts
  // Sync gate (design 2026-07-04): true while the connected validator
  // reports major sync, with the gate's hysteresis applied so the UI
  // doesn't flap near the tip. Transient like chainConnected — reset on
  // load, never trusted from persisted rows. Optional so pre-gate
  // persisted rows and existing fixtures parse cleanly; consumers
  // default to false/null when reading.
  nodeSyncing?: boolean;
  // Validator-reported sync progress from system_syncState (u64 as
  // string). Null when the RPC is absent or not yet polled.
  nodeSyncCurrentBlock?: string | null;
  nodeSyncHighestBlock?: string | null;
```

In `apps/indexer/core/state.ts`, add to the initial `observability` object literal (after the `chainConnected: false,` line):

```ts
    // Transient like chainConnected — a prior process's sync-gate state is
    // meaningless to a new process.
    nodeSyncing: false,
    nodeSyncCurrentBlock: null,
    nodeSyncHighestBlock: null,
```

And in `load()`, extend the reset spread:

```ts
      this.observability = {
        ...prior,
        chainConnected: false,
        selfIdentified: false,
        nodeSyncing: false,
        nodeSyncCurrentBlock: null,
        nodeSyncHighestBlock: null,
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/indexer/core/state.test.ts && bun test packages/shared`
Expected: PASS (all).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --filter @quip/shared typecheck && bun run --filter @quip/indexer typecheck
bunx prettier --write packages/shared/telemetry/response.ts apps/indexer/core/state.ts apps/indexer/core/state.test.ts
git add packages/shared/telemetry/response.ts apps/indexer/core/state.ts apps/indexer/core/state.test.ts
git commit -m "feat(telemetry): add node sync-state fields to IndexerObservability"
```

---

### Task 2: `getSyncState()` across the client surface

**Files:**
- Modify: `apps/indexer/clients/substrate-client/types.ts` (new `SyncStateInfo` interface + `SubstrateClient` method)
- Modify: `apps/indexer/clients/substrate-client/index.ts` (`PolkadotSubstrateClient` implementation)
- Modify: `apps/indexer/clients/substrate-client/fake.ts` (programmable sync state)
- Modify: `apps/indexer/substrate/ports.ts` (new `SyncSource` role, added to `ChainClient`)

**Interfaces:**
- Consumes: `requireApi()` / `api.rpc.system.*` inside the polkadot client.
- Produces:
  - `interface SyncStateInfo { isSyncing: boolean; peers: number; currentBlock: number | null; highestBlock: number | null }` (exported from `types.ts`, re-exported by the barrel via the existing `export * from "./types"`).
  - `SubstrateClient.getSyncState(): Promise<SyncStateInfo>` — throws on RPC failure.
  - `interface SyncSource { getSyncState(): Promise<SyncStateInfo> }` in `ports.ts`; `ChainClient` intersection gains `& SyncSource`.
  - `FakeSubstrateClient.syncState: SyncStateInfo` (mutable) and `FakeSubstrateClient.syncStateError: Error | null` (when set, `getSyncState` throws it).

- [ ] **Step 1: Add the type + interface method**

In `apps/indexer/clients/substrate-client/types.ts`, before the `SubstrateClient` interface:

```ts
// system_health + system_syncState snapshot (design 2026-07-04). isSyncing
// mirrors the node's major-sync flag; currentBlock/highestBlock are
// best-effort from system_syncState — null when that RPC is unavailable.
export interface SyncStateInfo {
  isSyncing: boolean;
  peers: number;
  currentBlock: number | null;
  highestBlock: number | null;
}
```

Inside `SubstrateClient` (after the `isConnected(): boolean;` line):

```ts
  // Node sync status for the indexer's sync gate. system_health is
  // required; system_syncState is best-effort. Throws on RPC failure —
  // the SyncGate keeps its last state on error (failure ≠ syncing).
  getSyncState(): Promise<SyncStateInfo>;
```

- [ ] **Step 2: Verify the typecheck fails (both impls now incomplete)**

Run: `bun run --filter @quip/indexer typecheck`
Expected: FAIL — `PolkadotSubstrateClient` and `FakeSubstrateClient` do not implement `getSyncState`.

- [ ] **Step 3: Implement in `PolkadotSubstrateClient`**

In `apps/indexer/clients/substrate-client/index.ts`, add `SyncStateInfo` to the type import list from `"./types"`, and add this method after `isConnected()` (~line 166):

```ts
  async getSyncState(): Promise<SyncStateInfo> {
    const api = this.requireApi();
    const health = await api.rpc.system.health();
    let currentBlock: number | null = null;
    let highestBlock: number | null = null;
    try {
      const sync = await api.rpc.system.syncState();
      currentBlock = sync.currentBlock.toNumber();
      // highestBlock is Option<BlockNumber> on current node versions.
      highestBlock = sync.highestBlock.isSome ? sync.highestBlock.unwrap().toNumber() : null;
    } catch {
      // system_syncState absent on this node; system_health alone still
      // drives the gate.
    }
    return {
      isSyncing: health.isSyncing.isTrue,
      peers: health.peers.toNumber(),
      currentBlock,
      highestBlock,
    };
  }
```

- [ ] **Step 4: Implement in `FakeSubstrateClient`**

In `apps/indexer/clients/substrate-client/fake.ts`, add `SyncStateInfo` to the type imports from `"./types"`, and add after `isConnected()`:

```ts
  // Sync-gate knobs: tests mutate `syncState` to simulate a node entering /
  // leaving major sync; set `syncStateError` to make getSyncState throw
  // (simulating an RPC failure).
  public syncState: SyncStateInfo = {
    isSyncing: false,
    peers: 1,
    currentBlock: null,
    highestBlock: null,
  };
  public syncStateError: Error | null = null;
  async getSyncState(): Promise<SyncStateInfo> {
    if (this.syncStateError) throw this.syncStateError;
    return this.syncState;
  }
```

- [ ] **Step 5: Add the `SyncSource` port role**

In `apps/indexer/substrate/ports.ts`: add `SyncStateInfo` to the type import list from `"../clients/substrate-client"`, then after the `PollSource` interface:

```ts
// Node sync status for the SyncGate (design 2026-07-04).
export interface SyncSource {
  getSyncState(): Promise<SyncStateInfo>;
}
```

And extend the intersection:

```ts
export type ChainClient = ConnectionControl &
  HeadSource &
  BlockSource &
  BackfillSource &
  PollSource &
  DescriptorSource &
  SyncSource;
```

- [ ] **Step 6: Typecheck + run the indexer suite**

Run: `bun run --filter @quip/indexer typecheck && bun test apps/indexer`
Expected: PASS — both clients satisfy the interface; no behavior change yet.

- [ ] **Step 7: Commit**

```bash
bunx prettier --write apps/indexer/clients/substrate-client/types.ts apps/indexer/clients/substrate-client/index.ts apps/indexer/clients/substrate-client/fake.ts apps/indexer/substrate/ports.ts
git add apps/indexer/clients/substrate-client/types.ts apps/indexer/clients/substrate-client/index.ts apps/indexer/clients/substrate-client/fake.ts apps/indexer/substrate/ports.ts
git commit -m "feat(indexer): add getSyncState to the substrate client surface"
```

---

### Task 3: `SyncGate` — detection with hysteresis

**Files:**
- Create: `apps/indexer/substrate/sync-gate.ts`
- Test: `apps/indexer/substrate/sync-gate.test.ts` (new)

**Interfaces:**
- Consumes: `SyncSource` and `ConnectionStream` from `./ports` (Task 2), `SyncStateInfo` from `../clients/substrate-client` (Task 2), `IndexerObservability` fields (Task 1).
- Produces (used by Tasks 5–7):
  - `class SyncGate implements ConnectionStream`
  - `new SyncGate(deps: SyncGateDeps)` where `SyncGateDeps = { client: SyncSource; state: Pick<IndexerState, "observability">; syncingPollMs?: number; syncedPollMs?: number; onResume?: () => void }`
  - `gated(): boolean` — true while heavy work must pause
  - `readonly resumed$: Subject<void>` — fires when the gate opens after a pause
  - `check(): Promise<void>` — one poll; public for tests and the worker's startup prime
  - exported constants `SYNCING_POLL_MS = 5_000`, `SYNCED_POLL_MS = 30_000`

- [ ] **Step 1: Write the failing tests**

Create `apps/indexer/substrate/sync-gate.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SyncGate (design 2026-07-04): hysteresis (close on first syncing poll,
// open only after 2 consecutive synced polls), error handling (keep last
// state), resume signaling, and observability publication.

import { describe, expect, test } from "bun:test";

import type { IndexerObservability } from "@quip/shared/telemetry";

import type { SyncStateInfo } from "../clients/substrate-client";
import { SyncGate } from "./sync-gate";

function makeObservability(): IndexerObservability {
  return {
    chainHeadFromNode: null,
    lastStatusFetchAt: new Date(0).toISOString(),
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: true,
    minerStats: null,
    nodeSyncing: false,
    nodeSyncCurrentBlock: null,
    nodeSyncHighestBlock: null,
  };
}

function makeGate(opts: { onResume?: () => void } = {}) {
  let next: SyncStateInfo | Error = {
    isSyncing: false,
    peers: 1,
    currentBlock: null,
    highestBlock: null,
  };
  const observability = makeObservability();
  const gate = new SyncGate({
    client: {
      getSyncState: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
    },
    state: { observability },
    onResume: opts.onResume,
  });
  return {
    gate,
    observability,
    set: (v: SyncStateInfo | Error) => {
      next = v;
    },
  };
}

const syncing = (cur: number | null = null, high: number | null = null): SyncStateInfo => ({
  isSyncing: true,
  peers: 2,
  currentBlock: cur,
  highestBlock: high,
});
const synced = (): SyncStateInfo => ({
  isSyncing: false,
  peers: 2,
  currentBlock: null,
  highestBlock: null,
});

describe("SyncGate hysteresis", () => {
  test("starts open; closes on the FIRST isSyncing poll", async () => {
    const { gate, set } = makeGate();
    expect(gate.gated()).toBe(false);
    set(syncing());
    await gate.check();
    expect(gate.gated()).toBe(true);
  });

  test("one synced poll is not enough to open; two consecutive are", async () => {
    const { gate, set } = makeGate();
    set(syncing());
    await gate.check();
    set(synced());
    await gate.check();
    expect(gate.gated()).toBe(true); // 1 consecutive — still paused
    await gate.check();
    expect(gate.gated()).toBe(false); // 2 consecutive — resumed
  });

  test("a syncing flap resets the consecutive-synced count", async () => {
    const { gate, set } = makeGate();
    set(syncing());
    await gate.check();
    set(synced());
    await gate.check(); // 1
    set(syncing());
    await gate.check(); // reset
    set(synced());
    await gate.check(); // 1 again
    expect(gate.gated()).toBe(true);
    await gate.check(); // 2
    expect(gate.gated()).toBe(false);
  });
});

describe("SyncGate error handling", () => {
  test("poll failure keeps the last state — open stays open, paused stays paused", async () => {
    const { gate, set } = makeGate();
    set(new Error("timeout"));
    await gate.check();
    expect(gate.gated()).toBe(false);

    set(syncing());
    await gate.check();
    set(new Error("timeout"));
    await gate.check();
    await gate.check();
    expect(gate.gated()).toBe(true); // errors never count as synced polls
  });
});

describe("SyncGate signals", () => {
  test("resumed$ and onResume fire exactly once per pause→resume transition", async () => {
    let resumes = 0;
    const { gate, set } = makeGate({ onResume: () => resumes++ });
    const seen: number[] = [];
    gate.resumed$.subscribe(() => seen.push(1));

    set(syncing());
    await gate.check();
    set(synced());
    await gate.check();
    await gate.check(); // opens here
    await gate.check(); // already open — no re-fire
    expect(resumes).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test("publishes gate state and progress to observability as u64 strings", async () => {
    const { gate, observability, set } = makeGate();
    set(syncing(406_173, 512_000));
    await gate.check();
    expect(observability.nodeSyncing).toBe(true);
    expect(observability.nodeSyncCurrentBlock).toBe("406173");
    expect(observability.nodeSyncHighestBlock).toBe("512000");

    set(synced());
    await gate.check();
    expect(observability.nodeSyncing).toBe(true); // hysteresis: still paused
    await gate.check();
    expect(observability.nodeSyncing).toBe(false);
    expect(observability.nodeSyncCurrentBlock).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/indexer/substrate/sync-gate.test.ts`
Expected: FAIL — `Cannot find module './sync-gate'`.

- [ ] **Step 3: Implement `SyncGate`**

Create `apps/indexer/substrate/sync-gate.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SyncGate (design 2026-07-04): poll system_health/system_syncState and gate
// heavy pipeline work while the connected validator is in major sync — its
// I/O is saturated importing blocks, and backfill dispatch / reconciler
// cross-checks / snapshot scans stall its synchronization. The gate closes
// (pauses) on the FIRST isSyncing=true poll and opens only after
// SYNCED_CONSECUTIVE_POLLS consecutive isSyncing=false polls, because nodes
// flap the flag near the tip. Poll failures keep the last state — never
// pause a healthy pipeline because one health poll timed out.

import { Subject, defer, ignoreElements, repeat, timer, type Observable } from "rxjs";

import type { SyncStateInfo } from "../clients/substrate-client";
import type { IndexerState } from "../core/state";
import type { ConnectionStream, SyncSource } from "./ports";

export const SYNCING_POLL_MS = 5_000;
export const SYNCED_POLL_MS = 30_000;
const SYNCED_CONSECUTIVE_POLLS = 2;
const FAILURES_BEFORE_WARN = 3;

export interface SyncGateDeps {
  client: SyncSource;
  state: Pick<IndexerState, "observability">;
  syncingPollMs?: number;
  syncedPollMs?: number;
  // Wakes the dispatcher the instant the gate opens (worker wires the
  // queue's wake fn) so drained tip items don't wait a retry interval.
  onResume?: () => void;
}

export class SyncGate implements ConnectionStream {
  /** Fires when the gate opens after a pause (reconciler re-tick). */
  readonly resumed$ = new Subject<void>();

  private isGated = false;
  private consecutiveSynced = 0;
  private failures = 0;

  constructor(private readonly deps: SyncGateDeps) {}

  /** True while heavy work (backfill, reconcile, snapshots) must pause. */
  gated(): boolean {
    return this.isGated;
  }

  stream(): Observable<never> {
    // check → sleep (5s while gated, 30s once synced) → repeat. The worker
    // runs the priming check() before the pipeline subscribes, so the
    // leading check here is a cheap refresh, not the startup detection.
    return defer(() => this.check()).pipe(
      repeat({
        delay: () =>
          timer(
            this.isGated
              ? (this.deps.syncingPollMs ?? SYNCING_POLL_MS)
              : (this.deps.syncedPollMs ?? SYNCED_POLL_MS),
          ),
      }),
      ignoreElements(),
    ) as Observable<never>;
  }

  /** One poll. Public for tests and for the worker's startup prime. */
  async check(): Promise<void> {
    let s: SyncStateInfo;
    try {
      s = await this.deps.client.getSyncState();
    } catch (err) {
      this.failures += 1;
      if (this.failures === FAILURES_BEFORE_WARN) {
        console.warn(
          `[indexer/substrate] sync-state poll failed ${this.failures}x; ` +
            `keeping gate ${this.isGated ? "paused" : "open"}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return; // failure ≠ syncing — keep the last state
    }
    this.failures = 0;

    if (s.isSyncing) {
      this.consecutiveSynced = 0;
      if (!this.isGated) {
        this.isGated = true;
        console.warn(`[indexer/substrate] validator is syncing${progress(s)} — pausing indexing`);
      }
    } else if (this.isGated) {
      this.consecutiveSynced += 1;
      if (this.consecutiveSynced >= SYNCED_CONSECUTIVE_POLLS) {
        this.isGated = false;
        console.warn(`[indexer/substrate] validator synced${progress(s)} — resuming indexing`);
        this.resumed$.next();
        this.deps.onResume?.();
      }
    }
    this.publish(s);
  }

  private publish(s: SyncStateInfo): void {
    const obs = this.deps.state.observability;
    // Publish the GATE state, not the raw flag — the UI inherits the
    // hysteresis so it doesn't flap near the tip.
    obs.nodeSyncing = this.isGated;
    obs.nodeSyncCurrentBlock = s.currentBlock === null ? null : String(s.currentBlock);
    obs.nodeSyncHighestBlock = s.highestBlock === null ? null : String(s.highestBlock);
  }
}

function progress(s: SyncStateInfo): string {
  if (s.currentBlock === null || s.highestBlock === null) return "";
  return ` (${s.currentBlock.toLocaleString("en-US")}/${s.highestBlock.toLocaleString("en-US")})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/indexer/substrate/sync-gate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
bunx prettier --write apps/indexer/substrate/sync-gate.ts apps/indexer/substrate/sync-gate.test.ts
git add apps/indexer/substrate/sync-gate.ts apps/indexer/substrate/sync-gate.test.ts
git commit -m "feat(indexer): add SyncGate with hysteresis and observability"
```

---

### Task 4: `QueueCore` gating

**Files:**
- Modify: `apps/indexer/pipeline/queue.ts` (`QueueCoreOpts` + `tryPull`)
- Test: `apps/indexer/pipeline/queue.test.ts` (append)

**Interfaces:**
- Consumes: nothing new (the gate closure is wired in Task 7).
- Produces: `QueueCoreOpts.gated?: () => boolean` and `QueueCoreOpts.gatedRetryMs?: number` (default `5_000`). While gated, `tryPull` returns `{ retryAtMs: nowMs + gatedRetryMs }` when anything is queued (tip items included) and `"empty"` when nothing is.

- [ ] **Step 1: Write the failing tests**

Append to `apps/indexer/pipeline/queue.test.ts`:

```ts
describe("sync gate", () => {
  test("gated tryPull holds EVERYTHING — tip included — and preserves contents", () => {
    let gated = true;
    const q = new QueueCore({
      backfillBlocksPerSec: 5,
      tipQuietMs: 750,
      lastEventAtMs: () => null,
      gated: () => gated,
    });
    q.enqueueTip(500, new Set(["winners"]));
    q.enqueueBackfill(100, "W", new Set(["winners"]));

    const r = q.tryPull(T0);
    expect(r).toHaveProperty("retryAtMs");
    expect((r as { retryAtMs: number }).retryAtMs).toBe(T0 + 5_000);

    // Opening the gate drains in normal priority order — nothing was lost.
    gated = false;
    expect(pullBlock(q, T0)).toBe(500);
    expect(pullBlock(q, T0)).toBe(100);
  });

  test("gated tryPull on an empty queue returns 'empty' (sleep until wake)", () => {
    const q = new QueueCore({
      backfillBlocksPerSec: 5,
      tipQuietMs: 750,
      lastEventAtMs: () => null,
      gated: () => true,
    });
    expect(q.tryPull(T0)).toBe("empty");
  });

  test("gatedRetryMs overrides the retry interval", () => {
    const q = new QueueCore({
      backfillBlocksPerSec: 5,
      tipQuietMs: 750,
      lastEventAtMs: () => null,
      gated: () => true,
      gatedRetryMs: 20,
    });
    q.enqueueTip(1, new Set(["winners"]));
    expect((q.tryPull(T0) as { retryAtMs: number }).retryAtMs).toBe(T0 + 20);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/indexer/pipeline/queue.test.ts`
Expected: FAIL — TypeScript error on the unknown `gated` option / tip item returned despite gating.

- [ ] **Step 3: Implement**

In `apps/indexer/pipeline/queue.ts`, extend `QueueCoreOpts`:

```ts
export interface QueueCoreOpts {
  // Per-lane budget (spec §13 default: 5).
  backfillBlocksPerSec: number;
  tipQuietMs: number;
  // Epoch ms of the last live substrate event, or null before the first.
  lastEventAtMs: () => number | null;
  // Sync gate (design 2026-07-04): while true, EVERY pull — tip included —
  // is held; queue contents are preserved and drain on resume. The
  // dispatcher sleeps gatedRetryMs between gated retries.
  gated?: () => boolean;
  gatedRetryMs?: number; // 5_000
}
```

And at the top of `tryPull`, before the tip shift:

```ts
  tryPull(nowMs: number): PullResult {
    if (this.opts.gated?.()) {
      const anyQueued =
        this.tip.length > 0 || this.lanes.W.length > 0 || this.lanes.D.length > 0;
      // Empty + gated sleeps until the next wake (a tip enqueue) rather
      // than spinning a retry timer for nothing.
      if (!anyQueued) return "empty";
      return { retryAtMs: nowMs + (this.opts.gatedRetryMs ?? 5_000) };
    }
    const tipItem = this.tip.shift();
    ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/indexer/pipeline/queue.test.ts`
Expected: PASS (all, including the pre-existing suites).

- [ ] **Step 5: Commit**

```bash
bunx prettier --write apps/indexer/pipeline/queue.ts apps/indexer/pipeline/queue.test.ts
git add apps/indexer/pipeline/queue.ts apps/indexer/pipeline/queue.test.ts
git commit -m "feat(indexer): gate queue pulls while the validator syncs"
```

---

### Task 5: `Reconciler` gating + resume re-tick

**Files:**
- Modify: `apps/indexer/pipeline/producers.ts` (`ReconcilerDeps`, `stream()`, `tick()`)
- Test: `apps/indexer/pipeline/producers.test.ts` (append)

**Interfaces:**
- Consumes: nothing new (wired in Task 7).
- Produces: `ReconcilerDeps.gated?: () => boolean` (tick returns early while true) and `ReconcilerDeps.resume$?: Observable<void>` (merged into the tick timer — REQUIRED for resume to work, because the next scheduled tick after a gated boot tick is 900s away).

- [ ] **Step 1: Write the failing tests**

Append to `apps/indexer/pipeline/producers.test.ts`. Extend the top-of-file imports: add `Reconciler` to the `./producers` import, and add `import { Subject } from "rxjs";`.

```ts
describe("Reconciler sync gating", () => {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Minimal deps: with an empty registry, an ungated tick touches only
  // getFinalizedHead + getQBlockNumbers + the two cross-check DB reads.
  function makeDeps(overrides: { gated?: () => boolean; resume$?: Subject<void> }) {
    const calls = { finalizedHead: 0 };
    const queue = makeQueue();
    const { walker } = makeWalker(queue);
    const deps = {
      db: {
        getExistingBlockNumbers: async () => [],
        getExistingDifficultyBlockNumbers: async () => [],
      } as never,
      client: {
        getFinalizedHead: async () => {
          calls.finalizedHead += 1;
          return "100";
        },
        getQBlockNumbers: async () => [],
      } as never,
      queue,
      walker,
      store: {} as never,
      registry: [],
      now: () => T0,
      ...overrides,
    };
    return { deps, calls };
  }

  test("tick() returns early while gated — no RPC touched", async () => {
    const { deps, calls } = makeDeps({ gated: () => true });
    const reconciler = new Reconciler(deps);
    await reconciler.tick();
    expect(calls.finalizedHead).toBe(0);
  });

  test("resume$ triggers an immediate tick once the gate opens", async () => {
    let gated = true;
    const resume$ = new Subject<void>();
    const { deps, calls } = makeDeps({ gated: () => gated, resume$ });
    const reconciler = new Reconciler({ ...deps, reconcileIntervalSec: 10_000 });
    const sub = reconciler.stream().subscribe();
    await wait(20); // leading tick fires gated → early return
    expect(calls.finalizedHead).toBe(0);
    gated = false;
    resume$.next();
    await wait(20);
    expect(calls.finalizedHead).toBe(1);
    sub.unsubscribe();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/indexer/pipeline/producers.test.ts`
Expected: FAIL — unknown `gated`/`resume$` deps; first test throws from the un-gated tick.

- [ ] **Step 3: Implement**

In `apps/indexer/pipeline/producers.ts`:

Add `merge` to the rxjs import:

```ts
import { Subject, timer, exhaustMap, ignoreElements, merge, tap, type Observable } from "rxjs";
```

Extend `ReconcilerDeps` (after `enrichmentFloor`):

```ts
  // Sync gate (design 2026-07-04): tick() returns early while gated;
  // resume$ triggers an immediate tick when the gate opens — the 900s
  // cadence would otherwise park the boot backfill for 15 minutes.
  gated?: () => boolean;
  resume$?: Observable<void>;
```

Replace `stream()`:

```ts
  stream(): Observable<never> {
    const intervalMs = (this.deps.reconcileIntervalSec ?? 900) * 1000;
    const tick$ = this.deps.resume$
      ? merge(timer(0, intervalMs), this.deps.resume$)
      : timer(0, intervalMs);
    return tick$.pipe(
      exhaustMap(() => runEffect("reconcile", () => this.tick())),
    ) as Observable<never>;
  }
```

At the top of `tick()`:

```ts
  async tick(): Promise<void> {
    const { deps } = this;
    // Sync gate: a syncing validator is saturating its own I/O — skip the
    // head fetch, winner enumeration, and cross-check entirely. resume$
    // re-ticks the moment the gate opens (design 2026-07-04).
    if (deps.gated?.()) return;
    const head = Number(await deps.client.getFinalizedHead());
    ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/indexer/pipeline/producers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx prettier --write apps/indexer/pipeline/producers.ts apps/indexer/pipeline/producers.test.ts
git add apps/indexer/pipeline/producers.ts apps/indexer/pipeline/producers.test.ts
git commit -m "feat(indexer): gate reconciler ticks and re-tick on resume"
```

---

### Task 6: `SnapshotScheduler` gating

**Files:**
- Modify: `apps/indexer/pipeline/snapshots.ts`
- Test: `apps/indexer/pipeline/snapshots.test.ts` (new)

**Interfaces:**
- Consumes: nothing new (wired in Task 7).
- Produces: `SnapshotSchedulerDeps.gated?: () => boolean` and `SnapshotSchedulerDeps.resume$?: Observable<void>`. Gated ticks are filtered BEFORE `--once`'s `take(1)` so once-mode still runs its single poll after resume.

- [ ] **Step 1: Write the failing tests**

Create `apps/indexer/pipeline/snapshots.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SnapshotScheduler sync gating (design 2026-07-04): gated ticks are
// skipped without consuming --once's take(1); resume$ re-polls promptly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Subject } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { FakeSubstrateClient } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";
import type { SnapshotIndexable } from "./plugin";
import { SnapshotScheduler } from "./snapshots";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function countingPlugin(calls: { n: number }): SnapshotIndexable {
  return {
    name: "counting",
    kind: "snapshot",
    intervalSec: () => 1_000, // never re-ticks within a test
    poll: async () => {
      calls.n += 1;
    },
    dropState: async () => {},
  };
}

let db: DatabaseAdapter;
beforeEach(async () => {
  db = await newInMemoryAdapter();
});
afterEach(async () => {
  await db.disconnect();
});

function makeScheduler(opts: {
  calls: { n: number };
  gated: () => boolean;
  resume$?: Subject<void>;
  once?: boolean;
}) {
  return new SnapshotScheduler({
    client: new FakeSubstrateClient(),
    db,
    state: new IndexerState(db),
    config: makeConfig(),
    snapshots: [countingPlugin(opts.calls)],
    once: opts.once,
    gated: opts.gated,
    resume$: opts.resume$,
  });
}

describe("SnapshotScheduler sync gating", () => {
  test("gated leading tick polls nothing; ungated leading tick polls", async () => {
    const gatedCalls = { n: 0 };
    const openCalls = { n: 0 };
    const sub1 = makeScheduler({ calls: gatedCalls, gated: () => true })
      .stream()
      .subscribe();
    const sub2 = makeScheduler({ calls: openCalls, gated: () => false })
      .stream()
      .subscribe();
    await wait(30);
    expect(gatedCalls.n).toBe(0);
    expect(openCalls.n).toBe(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("under --once a gated leading tick does NOT consume take(1); resume$ delivers the poll", async () => {
    let gated = true;
    const resume$ = new Subject<void>();
    const calls = { n: 0 };
    const sub = makeScheduler({ calls, gated: () => gated, resume$, once: true })
      .stream()
      .subscribe();
    await wait(20);
    expect(calls.n).toBe(0);
    gated = false;
    resume$.next();
    await wait(20);
    expect(calls.n).toBe(1);
    sub.unsubscribe();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/indexer/pipeline/snapshots.test.ts`
Expected: FAIL — unknown `gated`/`resume$` deps; gated tick still polls.

- [ ] **Step 3: Implement**

In `apps/indexer/pipeline/snapshots.ts`:

Update the rxjs import:

```ts
import { EMPTY, exhaustMap, filter, merge, take, timer, type Observable } from "rxjs";
```

Extend `SnapshotSchedulerDeps`:

```ts
export interface SnapshotSchedulerDeps {
  client: ChainClient;
  db: DatabaseAdapter;
  state: IndexerState;
  config: IndexerConfig;
  snapshots: SnapshotIndexable[];
  once?: boolean;
  // Sync gate (design 2026-07-04): gated ticks are filtered out BEFORE
  // --once's take(1) so once-mode still runs its single poll after the
  // node syncs; resume$ re-polls promptly instead of waiting a full
  // interval.
  gated?: () => boolean;
  resume$?: Observable<void>;
}
```

Replace the `stream()` body:

```ts
  stream(): Observable<never> {
    const { client, db, state, config, snapshots, once, gated, resume$ } = this.deps;
    const streams = snapshots
      .filter((p) => (p.driver ?? "scheduler") === "scheduler")
      .map((p) => {
        const base$ = timer(0, p.intervalSec(config) * 1000);
        const tick$ = (resume$ ? merge(base$, resume$) : base$).pipe(
          filter(() => !gated?.()),
        );
        return (once ? tick$.pipe(take(1)) : tick$).pipe(
          exhaustMap(() => runEffect(`${p.name} poll`, () => p.poll(client, db, state))),
        );
      });
    return streams.length > 0 ? (merge(...streams) as Observable<never>) : EMPTY;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/indexer/pipeline/snapshots.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
bunx prettier --write apps/indexer/pipeline/snapshots.ts apps/indexer/pipeline/snapshots.test.ts
git add apps/indexer/pipeline/snapshots.ts apps/indexer/pipeline/snapshots.test.ts
git commit -m "feat(indexer): gate snapshot polls while the validator syncs"
```

---

### Task 7: Worker wiring + integration test

**Files:**
- Modify: `apps/indexer/substrate/worker.ts` (`SubstrateWorkerDeps`, `connection()`)
- Test: `apps/indexer/substrate/worker.test.ts` (append)

**Interfaces:**
- Consumes: `SyncGate` (Task 3), `QueueCoreOpts.gated` (Task 4), `ReconcilerDeps.gated/resume$` (Task 5), `SnapshotSchedulerDeps.gated/resume$` (Task 6).
- Produces: `SubstrateWorkerDeps.syncGatePollMs?: { syncing?: number; synced?: number }` (test knob, like `chainHeadDebounceMs`). The worker runs one `syncGate.check()` between `client.connect()` and pipeline subscription so startup detection is deterministic, not a race against the reconciler's boot tick.

- [ ] **Step 1: Write the failing integration test**

Append to `apps/indexer/substrate/worker.test.ts`:

```ts
describe("sync gate integration", () => {
  test("backfill pauses while the validator syncs and drains on resume", async () => {
    const state = new IndexerState(db);
    await state.load();
    const client = new FakeSubstrateClient();
    client.syncState = { isSyncing: true, peers: 2, currentBlock: 50, highestBlock: 100 };
    client.topology = { nodeCount: 100, edgeCount: 200 };
    // A historical winner the reconciler's boot tick would normally
    // enumerate and backfill immediately.
    client.finalizedHead = "100";
    client.qblocksByBlock.set("100", {
      miner: "5GPP",
      energyMilli: -2510,
      reward: "1000",
      submittedAt: "100",
      nonce: "42",
      difficulty: { maxEnergyMilli: -2500, minDiversityMilli: 200, minSolutions: 5 },
      deviceAccessTimeUs: null,
    });
    client.lastProofBlockByHash.set("0xsub99", 94);
    client.historicalBlocks.set("100", {
      blockNumber: 100,
      blockHash: "0xsub",
      parentHash: "0xsub99",
      author: "5Author",
      timestamp: 1700000000,
      winner: {
        qblockId: "1",
        blockNumber: "100",
        miner: "5GPP",
        reward: "1000",
        energyMilli: -2510,
        submittedAt: "100",
      },
      proofs: [{ miner: "5GPP", energyMilli: -2510, diversityMilli: 420, validSolutionCount: 5 }],
      nonce: "42",
    });

    const ac = new AbortController();
    const loop = runSubstrateLoop(
      {
        config: makeConfig({ substrateBabePollSec: 1000, substrateChainPollSec: 1000 }),
        urls: ["ws://x"],
        clientFactory: () => client,
        db,
        state,
        chainHeadDebounceMs: 0,
        syncGatePollMs: { syncing: 20, synced: 20 },
        // Real clock: the tip-quiet gate compares lastSubstrateEventAt
        // (stamped at connect) against now — a pinned clock would hold
        // backfill forever.
      },
      ac.signal,
    );

    // Paused: the startup check saw isSyncing before the pipeline started.
    await wait(150);
    expect(await db.getRecentBlocks(10, 0)).toHaveLength(0);
    expect(state.observability.nodeSyncing).toBe(true);
    expect(state.observability.nodeSyncCurrentBlock).toBe("50");

    // Node finishes syncing: two 20ms polls open the gate, resume$ re-ticks
    // the reconciler, and the queue drains once the 750ms tip-quiet window
    // (anchored at connect) has passed.
    client.syncState = { isSyncing: false, peers: 2, currentBlock: 100, highestBlock: 100 };
    await wait(900);
    expect(state.observability.nodeSyncing).toBe(false);
    const blocks = await db.getRecentBlocks(10, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.blockHash).toBe("0xsub");

    ac.abort();
    await loop;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/indexer/substrate/worker.test.ts`
Expected: FAIL — unknown `syncGatePollMs` dep; without the gate the block is indexed while "syncing" (first assertion fails).

- [ ] **Step 3: Wire the gate into the worker**

In `apps/indexer/substrate/worker.ts`:

Add the import:

```ts
import { SyncGate } from "./sync-gate";
```

Extend `SubstrateWorkerDeps` and the constructor field (mirroring `chainHeadDebounceMs`):

```ts
export interface SubstrateWorkerDeps {
  config: IndexerConfig;
  // Round-robined on connect failure for endpoint fallback.
  urls: string[];
  // Builds a fresh client per connect attempt (each is bound to one URL).
  clientFactory: (url: string) => ChainClient;
  db: DatabaseAdapter;
  state: IndexerState;
  now?: () => number;
  chainHeadDebounceMs?: number;
  // Sync-gate poll cadence overrides (tests shrink them).
  syncGatePollMs?: { syncing?: number; synced?: number };
}
```

```ts
  private readonly syncGatePollMs?: { syncing?: number; synced?: number };
```

and in the constructor:

```ts
    this.syncGatePollMs = deps.syncGatePollMs;
```

In `connection()`, after `const wake = (): void => wake$.next();` and BEFORE the `QueueCore` construction:

```ts
    // Sync gate (design 2026-07-04): pause-in-place while the validator is
    // in major sync. Consulted by the queue, reconciler, and snapshot
    // scheduler; chain-head + tip subscriptions stay live so the dashboard
    // shows sync progress.
    const syncGate = new SyncGate({
      client,
      state: ctx.state,
      syncingPollMs: this.syncGatePollMs?.syncing,
      syncedPollMs: this.syncGatePollMs?.synced,
      onResume: wake,
    });
```

Add to the `QueueCore` options:

```ts
    const queue = new QueueCore({
      backfillBlocksPerSec: BACKFILL_BLOCKS_PER_SEC,
      tipQuietMs: TIP_QUIET_MS,
      gated: () => syncGate.gated(),
      lastEventAtMs: () => {
        ...
      },
    });
```

Add to the `Reconciler` deps (after `enrichmentFloor`):

```ts
      gated: () => syncGate.gated(),
      resume$: syncGate.resumed$,
```

Add to the `SnapshotScheduler` deps (after `once`):

```ts
        gated: () => syncGate.gated(),
        resume$: syncGate.resumed$,
```

Add `syncGate` FIRST in the streams array:

```ts
    const streams: readonly ConnectionStream[] = [
      syncGate,
      new ChainHeadWriter(this.ctx, this.chainHeadDebounceMs, client),
      ...
```

Finally, make startup detection deterministic — run one gate check between connect and pipeline subscription. Replace the return pipeline's start:

```ts
    return defer(() => client.connect()).pipe(
      tap(() => {
        this.ctx.state.observability.chainConnected = true;
        this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
      }),
      // Prime the sync gate BEFORE the pipeline subscribes, so a validator
      // in major sync is detected at startup rather than racing the
      // reconciler's boot tick. check() swallows RPC errors (gate stays
      // open), so this cannot fail the connection.
      concatMap(() => syncGate.check()),
      concatMap(() => gated$),
      finalize(() => {
        void client.disconnect().catch(() => {});
        this.ctx.state.observability.chainConnected = false;
      }),
    );
```

- [ ] **Step 4: Run the indexer suite**

Run: `bun test apps/indexer`
Expected: PASS — the new integration test plus every pre-existing test (the gate defaults to open on a fake that reports `isSyncing: false`, so nothing else changes behavior).

- [ ] **Step 5: Commit**

```bash
bunx prettier --write apps/indexer/substrate/worker.ts apps/indexer/substrate/worker.test.ts
git add apps/indexer/substrate/worker.ts apps/indexer/substrate/worker.test.ts
git commit -m "feat(indexer): wire SyncGate into the substrate worker"
```

---

### Task 8: Frontend — "Node syncing" SyncIndicator state

**Files:**
- Modify: `apps/frontend/src/lib/staleness.ts` (`SubstrateHealthLevel` + `computeSubstrateHealth`)
- Modify: `apps/frontend/src/components/layout/SyncIndicator.tsx` (`SUBSTRATE_DOT_STYLES` + memo deps)
- Modify: `apps/frontend/src/components/layout/SyncIndicator.stories.tsx` (new story)
- Test: `apps/frontend/src/lib/staleness.test.ts`, `apps/frontend/src/components/layout/SyncIndicator.test.tsx` (append)

**Interfaces:**
- Consumes: `IndexerObservability.nodeSyncing` / `nodeSyncCurrentBlock` / `nodeSyncHighestBlock` (Task 1).
- Produces: `SubstrateHealthLevel` gains `"syncing"`; `computeSubstrateHealth` returns `{ level: "syncing", ageMs: null, reason }` where `reason` is `Validator is syncing · block 406,173 of 512,000` (or `Validator is syncing` without progress).

- [ ] **Step 1: Write the failing tests**

Append to `apps/frontend/src/lib/staleness.test.ts` (inside or after the existing `computeSubstrateHealth` describe block, reusing the file's `obs()` helper and `NOW_MS`):

```ts
describe("computeSubstrateHealth — node syncing", () => {
  it("reports syncing when connected with fresh events but nodeSyncing set", () => {
    const h = computeSubstrateHealth(
      obs({
        chainConnected: true,
        lastSubstrateEventAt: new Date(NOW_MS - 5_000).toISOString(),
        nodeSyncing: true,
        nodeSyncCurrentBlock: "406173",
        nodeSyncHighestBlock: "512000",
      }),
      NOW_MS,
    );
    expect(h.level).toBe("syncing");
    expect(h.reason).toBe("Validator is syncing · block 406,173 of 512,000");
  });

  it("omits progress when the node did not report it", () => {
    const h = computeSubstrateHealth(
      obs({
        chainConnected: true,
        lastSubstrateEventAt: new Date(NOW_MS - 5_000).toISOString(),
        nodeSyncing: true,
      }),
      NOW_MS,
    );
    expect(h.level).toBe("syncing");
    expect(h.reason).toBe("Validator is syncing");
  });

  it("offline wins over syncing when the socket is down", () => {
    const h = computeSubstrateHealth(
      obs({
        chainConnected: false,
        lastSubstrateEventAt: new Date(NOW_MS - 5_000).toISOString(),
        nodeSyncing: true,
      }),
      NOW_MS,
    );
    expect(h.level).toBe("offline");
  });
});
```

Append to `apps/frontend/src/components/layout/SyncIndicator.test.tsx` (inside the existing describe):

```ts
  test("shows the syncing dot with progress when the validator is in major sync", () => {
    useTelemetryStore.setState((s) => ({
      ...s,
      blocks: [recentBlock()],
      indexer: baseObs({
        chainConnected: true,
        lastSubstrateEventAt: new Date(Date.now() - 5_000).toISOString(),
        nodeSyncing: true,
        nodeSyncCurrentBlock: "406173",
        nodeSyncHighestBlock: "512000",
      }),
    }));
    render(createElement(SyncIndicator));
    const dot = container.querySelector('[aria-label="Validator syncing"]');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("title")).toContain("406,173");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/frontend/src/lib/staleness.test.ts apps/frontend/src/components/layout/SyncIndicator.test.tsx`
Expected: FAIL — level comes back `"ok"`; no `Validator syncing` dot rendered.

- [ ] **Step 3: Implement `staleness.ts`**

Update the level union:

```ts
/** Substrate worker health (separate dimension from REST chain health). */
export type SubstrateHealthLevel = "disabled" | "ok" | "syncing" | "stale" | "offline";
```

In `computeSubstrateHealth`, insert AFTER the `!indexer.chainConnected` early return and BEFORE the `Date.parse(indexer.lastSubstrateEventAt)` freshness checks:

```ts
  // Node syncing outranks freshness: a validator in major sync emits heads
  // constantly, so the ok/stale windows would misreport it as healthy. The
  // gate's hysteresis is applied upstream (nodeSyncing IS the gate state).
  if (indexer.nodeSyncing) {
    return { level: "syncing", ageMs: null, reason: formatSyncProgress(indexer) };
  }
```

And add next to `formatApproxDuration` at the bottom:

```ts
function formatSyncProgress(indexer: IndexerObservability): string {
  const cur = indexer.nodeSyncCurrentBlock;
  const high = indexer.nodeSyncHighestBlock;
  if (!cur || !high) return "Validator is syncing";
  const fmt = (v: string) => Number(v).toLocaleString("en-US");
  return `Validator is syncing · block ${fmt(cur)} of ${fmt(high)}`;
}
```

Update the doc comment on `computeSubstrateHealth` to mention the new tier (between "ok" and "stale"):

```ts
 *   - "syncing": the connected validator reports major sync — the indexer
 *     is deliberately paused, not stalled.
```

- [ ] **Step 4: Implement `SyncIndicator.tsx`**

Add a `syncing` entry to `SUBSTRATE_DOT_STYLES` (between `ok` and `stale` — blue, pulsing, visually distinct from both the green "connected" and amber "stale" dots):

```ts
  syncing: {
    dotColor: "#3b82f6",
    dotAnim: "pulse",
    title: "Validator syncing",
  },
```

Extend the substrate memo's dependency list so it recomputes when sync state changes:

```ts
  const substrate = useMemo(
    () => computeSubstrateHealth(indexer, nowMs),
    [
      nowMs,
      indexer?.lastSubstrateEventAt,
      indexer?.chainConnected,
      indexer?.nodeSyncing,
      indexer?.nodeSyncCurrentBlock,
      indexer?.nodeSyncHighestBlock,
      indexer,
    ],
  );
```

(No other render changes needed — the existing dot renderer already shows `substrateStyle.title + " · " + substrate.reason` in the tooltip and `aria-label`.)

- [ ] **Step 5: Add the story**

Append to `apps/frontend/src/components/layout/SyncIndicator.stories.tsx`, mirroring the `Live` story's `StoryServices` shape:

```tsx
export const NodeSyncing: Story = () => (
  <StoryServices
    telemetry={{
      loading: false,
      serverTime: new Date(nowMs).toISOString(),
      blocks: [recentBlock()],
      indexer: observability({
        nodeSyncing: true,
        nodeSyncCurrentBlock: "406173",
        nodeSyncHighestBlock: "512000",
      }),
    }}
  >
    <SyncIndicator />
  </StoryServices>
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test apps/frontend/src/lib/staleness.test.ts apps/frontend/src/components/layout/SyncIndicator.test.tsx && bun run --filter @quip/frontend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
bunx prettier --write apps/frontend/src/lib/staleness.ts apps/frontend/src/lib/staleness.test.ts apps/frontend/src/components/layout/SyncIndicator.tsx apps/frontend/src/components/layout/SyncIndicator.test.tsx apps/frontend/src/components/layout/SyncIndicator.stories.tsx
git add apps/frontend/src/lib/staleness.ts apps/frontend/src/lib/staleness.test.ts apps/frontend/src/components/layout/SyncIndicator.tsx apps/frontend/src/components/layout/SyncIndicator.test.tsx apps/frontend/src/components/layout/SyncIndicator.stories.tsx
git commit -m "feat(frontend): show node-syncing state in SyncIndicator"
```

---

### Final verification (after all tasks)

- [ ] Run the full suite and typecheck:

```bash
bun test --path-ignore-patterns '**/reference-material/**'
bun run typecheck
bun run format:check
```

Expected: all pass, no formatting drift.

## Design decisions locked in (from spec → code mapping)

1. **Gate starts open; startup detection is a primed check, not a race.** The worker awaits one `syncGate.check()` between `client.connect()` and subscribing the pipeline, so a syncing validator is gated before the reconciler's boot tick can run. A healthy node pays one cheap `system_health` round-trip at connect — no multi-second startup delay.
2. **`resumed$` is load-bearing, not cosmetic.** The reconciler's cadence is 900s; without a resume re-tick, a gated boot tick would park the backfill for 15 minutes after the node syncs.
3. **`nodeSyncing` publishes the gate state (hysteresis applied), not the raw flag** — the UI inherits flap protection for free.
4. **Gated `tryPull` holds tip items too** (spec: "tip blocks enqueued during the pause wait in the queue and drain on resume"); `ChainHeadWriter` and `TipEnqueuer` subscriptions are untouched.
5. **SnapshotScheduler filters gated ticks before `take(1)`** so `--once` still runs each snapshot exactly once, after resume.
