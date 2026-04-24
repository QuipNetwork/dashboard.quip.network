# Tip-priority indexer & sync indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the dashboard indexer into a tight tip-follower loop and a background backfiller, and add a header status pill that reflects the indexer's five-state health.

**Architecture:** Two concurrent async workers in one Node.js process, sharing `IndexerState` + `DatabaseAdapter` + `chainAnchors`, each with its own `QuipClient` for isolated rate-limit backoff. Observability exposes two cursors (`tipEpoch`/`tipBlockIndex`, `backfillEpoch`/`backfillBlockIndex`). The UI's `computeChainHealth` derives a `SyncStage` enum from those fields; a new `<SyncIndicator />` pill renders it in the header's left cell stacked above the aggregation toggle.

**Tech Stack:** TypeScript, Bun runtime, Bun test (`bun test`), Zustand store, React 19, Tailwind 4, SQLite (`bun:sqlite`) + Postgres (`postgres` driver).

**Design spec:** `docs/superpowers/specs/2026-04-23-tip-priority-indexer-and-sync-indicator-design.md`

**One spec deviation:** The spec referenced `state.json` persistence; the codebase actually persists indexer state to the `indexer_state` SQL table (and `meta` JSON blobs). This plan stores the new two-cursor state in the existing `meta` table under a single JSON key (`indexer_cursors`). On startup, if the stored JSON is missing or fails shape validation, both cursors seed fresh — identical effect to the spec's "wipe on mismatch" without requiring a `SCHEMA_VERSION` bump.

---

## File structure

**New files:**

| Path                                           | Responsibility                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexer/shared.ts`                            | Helpers used by both workers: `updateStallTracker`, `maybeWarnStalled`, `isNodeStalled`, `buildCanonicalPlan`, `ensureChainAnchor`, `resolveSelfAddress`, `refreshSelfAddress`, `formatErr`, `logPrefix`, `defaultSleep`, the `CanonicalEpoch` type. Pure relocation from `loop.ts` — no behavior change. |
| `indexer/tip-worker.ts`                        | `runTipLoop(deps, signal)`, `runTipIteration(deps, nowMs)`, `computeTipOwnedStart(status, epochsBody, state)`.                                                                                                                                                                                            |
| `indexer/tip-worker.test.ts`                   | Tip-worker behavior tests.                                                                                                                                                                                                                                                                                |
| `indexer/backfill-worker.ts`                   | `runBackfillLoop(deps, signal)`, `runBackfillIteration(deps, nowMs)`, `reorderCanonicalFirst(plan, tipEpoch, chainAnchors)`, `markPlanEntriesDone(plan, db)`.                                                                                                                                             |
| `indexer/backfill-worker.test.ts`              | Backfill-worker behavior tests.                                                                                                                                                                                                                                                                           |
| `src/components/layout/SyncIndicator.tsx`      | The new pill component.                                                                                                                                                                                                                                                                                   |
| `src/components/layout/SyncIndicator.test.tsx` | Per-stage render tests.                                                                                                                                                                                                                                                                                   |

**Modified files:**

| Path                                                      | Change                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/telemetry.ts`                                  | `IndexerObservability`: `cursorEpoch`/`cursorBlockIndex` → `tipEpoch`/`tipBlockIndex` + add `backfillEpoch`/`backfillBlockIndex`.                                         |
| `api/db/adapter.ts`                                       | `parseIndexerObservability` validates new shape. Add `getCursors`/`saveCursors` methods (replacing `getCursor`/`saveCursor`). Keep `getEtags` — read from same JSON blob. |
| `api/db/sqlite.ts`, `api/db/postgres.ts`                  | Implement new DB methods; store `{tipCursor, backfillCursor, etags}` as JSON in `meta[indexer_cursors]`.                                                                  |
| `api/db/sqlite.test.ts`, `api/db/postgres.test.ts`        | Add round-trip tests for new methods; update observability tests for new shape.                                                                                           |
| `indexer/state.ts`                                        | Replace `cursor` with `tipCursor` + `backfillCursor`. `load()`/`save()` use new adapter methods.                                                                          |
| `indexer/config.ts`                                       | Add `backfillIdleRecheckSec` with `BACKFILL_IDLE_RECHECK_SEC` env / `--backfill-idle-recheck` flag (default 300).                                                         |
| `indexer/config.test.ts`                                  | Parse test for new knob.                                                                                                                                                  |
| `indexer/main.ts`                                         | Spawn two workers in parallel with a shared `AbortController`; map `AuthError` from either to abort-and-exit(1).                                                          |
| `indexer/loop.ts`                                         | Deleted (contents split across `shared.ts`, `tip-worker.ts`, `backfill-worker.ts`).                                                                                       |
| `indexer/loop.test.ts`                                    | Deleted; tests moved to `tip-worker.test.ts` / `backfill-worker.test.ts` / `shared.test.ts`.                                                                              |
| `indexer/shared.test.ts` (new if needed)                  | `buildCanonicalPlan` and stall-tracker tests that didn't fit in worker-specific files.                                                                                    |
| `src/lib/staleness.ts`                                    | New `SyncStage` type. `ChainHealth` gains `stage` + `detail`; `indexerLagBlocks` → `tipLagBlocks`. Rewrite `computeChainHealth` to populate the new fields.               |
| `src/lib/staleness.test.ts`                               | Update `obs()` to new shape; keep existing scenarios; add per-stage tests.                                                                                                |
| `src/components/layout/Header.tsx`                        | Left cell becomes `flex flex-col` stack: `<SyncIndicator />` above conditional `<AggregationToggle />`.                                                                   |
| `src/components/views/Network/RecentBlocksTable.tsx`      | Field renames (`cursorEpoch` → `tipEpoch`).                                                                                                                               |
| `src/components/views/Network/RecentBlocksTable.test.tsx` | `obs()` field renames.                                                                                                                                                    |
| `src/store/telemetry-store.ts`                            | Add `selectTipBlockTimestampMs` selector for `SyncIndicator`.                                                                                                             |
| `server/app.test.ts`                                      | `obs()` field renames.                                                                                                                                                    |
| `.gitignore`                                              | Already updated (adds `.superpowers/`).                                                                                                                                   |

---

## Task 1: Update `IndexerObservability` type and parser

**Files:**

- Modify: `src/types/telemetry.ts:143-150`
- Modify: `api/db/adapter.ts:28-67`

Nothing uses these fields in new-shape form yet, so this is a pure rename + additions. Consumers (staleness, store, tests) are updated in later tasks as we touch them.

- [ ] **Step 1: Write failing test for the parser**

Add to `api/db/adapter.test.ts` (create the file if it doesn't exist):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { parseIndexerObservability } from "./adapter";

describe("parseIndexerObservability", () => {
  it("parses a valid new-shape blob", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      tipEpoch: "abc123",
      tipBlockIndex: 42,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    const parsed = parseIndexerObservability(blob, "sqlite");
    expect(parsed).not.toBeNull();
    expect(parsed!.tipEpoch).toBe("abc123");
    expect(parsed!.backfillEpoch).toBeNull();
    expect(parsed!.backfillBlockIndex).toBe(0);
  });

  it("rejects old-shape blobs (cursorEpoch/cursorBlockIndex)", () => {
    const oldBlob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      cursorEpoch: "abc123",
      cursorBlockIndex: 42,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    expect(parseIndexerObservability(oldBlob, "sqlite")).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseIndexerObservability("{not json", "sqlite")).toBeNull();
  });

  it("rejects blobs missing backfill fields", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL on new-shape expectations**

Run: `bun test api/db/adapter.test.ts -t parseIndexerObservability`
Expected: test suite fails because `parseIndexerObservability` still validates the old `cursorEpoch` shape.

- [ ] **Step 3: Update the type**

In `src/types/telemetry.ts`, replace lines 143–150:

```ts
export interface IndexerObservability {
  nodeLatestEpoch: EpochId;
  nodeLatestBlockIndex: number;

  // Tip follower — cursor on status.latestEpoch's owned range.
  // tipEpoch === nodeLatestEpoch && tipBlockIndex === nodeLatestBlockIndex
  // means the tip is caught up.
  tipEpoch: EpochId | null;
  tipBlockIndex: number;

  // Backfill worker — null when no outstanding plan work; otherwise the
  // epoch currently being walked.
  backfillEpoch: EpochId | null;
  backfillBlockIndex: number;

  lastStatusFetchAt: string; // tip-worker heartbeat (ISO 8601)
  lastBlockInsertAt: string | null; // either worker's most recent insert
}
```

- [ ] **Step 4: Update the parser**

In `api/db/adapter.ts`, replace the body of `parseIndexerObservability` (lines 48–66):

```ts
if (
  !isStr(p.nodeLatestEpoch) ||
  !isFiniteInt(p.nodeLatestBlockIndex) ||
  !isNullableStr(p.tipEpoch) ||
  !isFiniteInt(p.tipBlockIndex) ||
  !isNullableStr(p.backfillEpoch) ||
  !isFiniteInt(p.backfillBlockIndex) ||
  !isStr(p.lastStatusFetchAt) ||
  !isNullableStr(p.lastBlockInsertAt)
) {
  console.warn(`[db/${source}] corrupt indexer_observability: shape mismatch`);
  return null;
}
return {
  nodeLatestEpoch: p.nodeLatestEpoch,
  nodeLatestBlockIndex: p.nodeLatestBlockIndex,
  tipEpoch: p.tipEpoch,
  tipBlockIndex: p.tipBlockIndex,
  backfillEpoch: p.backfillEpoch,
  backfillBlockIndex: p.backfillBlockIndex,
  lastStatusFetchAt: p.lastStatusFetchAt,
  lastBlockInsertAt: p.lastBlockInsertAt,
};
```

- [ ] **Step 5: Fix type-check errors across the codebase by renaming field references only**

Run: `bun run tsc --noEmit`
Expected: compile errors in `indexer/loop.ts`, `indexer/loop.test.ts`, `src/lib/staleness.ts`, `src/lib/staleness.test.ts`, `src/components/views/Network/RecentBlocksTable.test.tsx`, `server/app.test.ts`. Rename `cursorEpoch` → `tipEpoch`, `cursorBlockIndex` → `tipBlockIndex`, and add `backfillEpoch: null, backfillBlockIndex: 0` to every `obs()` / fixture literal. **Do not change any logic or add new features** — the goal of this task is purely to establish the new field names.

In `indexer/loop.ts:117-124`, the `setIndexerObservability` call body becomes:

```ts
await db.setIndexerObservability({
  nodeLatestEpoch: status.latestEpoch,
  nodeLatestBlockIndex: status.latestBlockIndex,
  tipEpoch: state.cursor.epoch,
  tipBlockIndex: state.cursor.blockIndex,
  backfillEpoch: null,
  backfillBlockIndex: 0,
  lastStatusFetchAt: new Date(nowMs).toISOString(),
  lastBlockInsertAt: state.observability.lastBlockInsertAt,
});
```

(Backfill is tracked as "nothing outstanding" until the backfill worker exists. The tip/backfill split happens in later tasks.)

In `src/lib/staleness.ts`:

- line 72: replace `indexer.cursorEpoch === indexer.nodeLatestEpoch` with `indexer.tipEpoch === indexer.nodeLatestEpoch`
- line 73: replace `indexer.cursorBlockIndex` with `indexer.tipBlockIndex`
- line 116: replace `indexer.cursorEpoch !== null` with `indexer.tipEpoch !== null`
- line 117: replace `indexer.cursorEpoch !== indexer.nodeLatestEpoch` with `indexer.tipEpoch !== indexer.nodeLatestEpoch`

Leave `indexerLagBlocks` in the return shape for now; Task 4 renames it.

- [ ] **Step 6: Run the parser tests — expect PASS**

Run: `bun test api/db/adapter.test.ts -t parseIndexerObservability`
Expected: all 4 tests pass.

- [ ] **Step 7: Run the full suite — expect PASS**

Run: `bun test`
Expected: every test that previously passed still passes. Nothing should fail from this rename.

- [ ] **Step 8: Commit**

```bash
git add src/types/telemetry.ts api/db/adapter.ts api/db/adapter.test.ts \
        indexer/loop.ts indexer/loop.test.ts \
        src/lib/staleness.ts src/lib/staleness.test.ts \
        src/components/views/Network/RecentBlocksTable.test.tsx \
        server/app.test.ts
git commit -m "refactor(indexer): rename observability cursor fields to tip/backfill"
```

---

## Task 2: Add DB methods for two-cursor persistence

**Files:**

- Modify: `api/db/adapter.ts:74-109` (DatabaseAdapter interface)
- Modify: `api/db/sqlite.ts:311-354`
- Modify: `api/db/postgres.ts` (analogous methods)
- Modify: `api/db/sqlite.test.ts`, `api/db/postgres.test.ts`

Store both cursors + etags as a JSON blob under `meta[indexer_cursors]`. Keep the existing `indexer_state` table untouched (no schema migration). On missing key or parse failure, return fresh defaults — this is the "wipe on mismatch" semantics from the spec.

- [ ] **Step 1: Write failing test for round-trip**

Add to `api/db/sqlite.test.ts`:

```ts
describe("getCursors / saveCursors", () => {
  it("returns fresh defaults when no cursors have been saved", async () => {
    const db = await freshSqlite();
    const c = await db.getCursors();
    expect(c.tip).toEqual({ epoch: null, blockIndex: 0 });
    expect(c.backfill).toEqual({ epoch: null, blockIndex: 0 });
    await db.disconnect();
  });

  it("round-trips tip + backfill + etags", async () => {
    const db = await freshSqlite();
    await db.saveCursors(
      { epoch: "abc", blockIndex: 42 },
      { epoch: "def", blockIndex: 17 },
      { nodes: "etag-1" },
    );
    const c = await db.getCursors();
    expect(c.tip).toEqual({ epoch: "abc", blockIndex: 42 });
    expect(c.backfill).toEqual({ epoch: "def", blockIndex: 17 });
    expect((await db.getEtags()).nodes).toBe("etag-1");
    await db.disconnect();
  });

  it("treats a corrupt indexer_cursors blob as 'no cursors'", async () => {
    const db = await freshSqlite();
    // Write garbage under the key the adapter reads from.
    await db.setMetaRaw("indexer_cursors", "{not json");
    const c = await db.getCursors();
    expect(c.tip).toEqual({ epoch: null, blockIndex: 0 });
    expect(c.backfill).toEqual({ epoch: null, blockIndex: 0 });
    await db.disconnect();
  });
});
```

(`freshSqlite()` is the existing test helper in `sqlite.test.ts`; `setMetaRaw` is a new test-only helper that writes any value under a meta key — add it as a private method on the adapter, or inline the raw INSERT.)

- [ ] **Step 2: Run the test — expect FAIL**

Run: `bun test api/db/sqlite.test.ts -t "getCursors"`
Expected: FAIL — `db.getCursors is not a function`.

- [ ] **Step 3: Update the adapter interface**

In `api/db/adapter.ts`, replace lines 93–95 in the `DatabaseAdapter` interface:

```ts
  // Two-cursor persistence (replaces the old single-cursor getCursor/saveCursor).
  // Stored as a JSON blob in meta[indexer_cursors]; missing-key or parse failure
  // returns fresh {epoch:null, blockIndex:0} defaults for both cursors —
  // equivalent to a clean state.json wipe from the design spec.
  getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }>;
  saveCursors(
    tip: IndexerCursor,
    backfill: IndexerCursor,
    etags: { nodes?: string | null },
  ): Promise<void>;
  getEtags(): Promise<{ nodes: string | null }>;
```

- [ ] **Step 4: Implement in SQLite**

In `api/db/sqlite.ts`, add the meta key constant near line 71:

```ts
const INDEXER_CURSORS_KEY = "indexer_cursors";
```

Replace `getCursor` / `saveCursor` / `getEtags` (lines 311–354) with:

```ts
  async getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(INDEXER_CURSORS_KEY);
    return parseIndexerCursors(row?.value ?? null, "sqlite");
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
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: INDEXER_CURSORS_KEY, $v: payload });
  }

  async getEtags(): Promise<{ nodes: string | null }> {
    const row = this.requireDb()
      .query<{ value: string | null }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(INDEXER_CURSORS_KEY);
    const parsed = parseIndexerCursorsRaw(row?.value ?? null);
    return { nodes: parsed?.etags?.nodes ?? null };
  }
```

Add the parser helpers in `api/db/adapter.ts` (alongside `parseIndexerObservability`):

```ts
/**
 * Parse the meta[indexer_cursors] JSON. Returns null on any parse/shape
 * failure; the caller's fallback policy decides what to do (typically: treat
 * as "no cursors" and let both workers seed fresh).
 */
export function parseIndexerCursorsRaw(
  raw: string | null,
): { tip: IndexerCursor; backfill: IndexerCursor; etags: { nodes: string | null } } | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const isCursor = (v: unknown): v is IndexerCursor => {
    if (typeof v !== "object" || v === null) return false;
    const c = v as Record<string, unknown>;
    return (
      (typeof c.epoch === "string" || c.epoch === null) &&
      typeof c.blockIndex === "number" &&
      Number.isFinite(c.blockIndex)
    );
  };
  if (!isCursor(p.tip) || !isCursor(p.backfill)) return null;
  const etags = p.etags as Record<string, unknown> | null | undefined;
  const nodes =
    etags && (typeof etags.nodes === "string" || etags.nodes === null)
      ? (etags.nodes as string | null)
      : null;
  return { tip: p.tip, backfill: p.backfill, etags: { nodes } };
}

/**
 * Like `parseIndexerCursorsRaw` but always returns a usable pair — fresh
 * defaults on any parse failure. Use in hot paths that just want "where
 * should the cursors seed?" without caring whether a prior blob existed.
 */
export function parseIndexerCursors(
  raw: string | null,
  source: "sqlite" | "postgres",
): { tip: IndexerCursor; backfill: IndexerCursor } {
  const fresh: IndexerCursor = { epoch: null, blockIndex: 0 };
  const parsed = parseIndexerCursorsRaw(raw);
  if (parsed) return { tip: parsed.tip, backfill: parsed.backfill };
  if (raw !== null) {
    console.warn(`[db/${source}] indexer_cursors missing or malformed; seeding fresh`);
  }
  return { tip: { ...fresh }, backfill: { ...fresh } };
}
```

Export them from `adapter.ts` and import where needed in `sqlite.ts` / `postgres.ts`.

- [ ] **Step 5: Implement in Postgres**

In `api/db/postgres.ts`, apply the analogous replacement around the existing `getCursor`/`saveCursor`/`getEtags` methods. Use the same `meta[indexer_cursors]` key and the same `parseIndexerCursors` / `parseIndexerCursorsRaw` helpers imported from `./adapter`.

- [ ] **Step 6: Add the `setMetaRaw` test helper on both adapters**

In `api/db/sqlite.ts`, add:

```ts
  /** @internal test-only — write a raw value under a meta key. */
  async setMetaRaw(key: string, value: string): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($k, $v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $k: key, $v: value });
  }
```

And analogous in `api/db/postgres.ts`. Expose on the `DatabaseAdapter` interface with a `@internal` JSDoc tag to signal it's for tests.

- [ ] **Step 7: Run the SQLite tests — expect PASS**

Run: `bun test api/db/sqlite.test.ts -t "getCursors"`
Expected: all three tests pass.

- [ ] **Step 8: Run the Postgres tests — expect PASS**

Run: `bun test api/db/postgres.test.ts -t "getCursors"`
Expected: all three tests pass (add the same 3-test block for postgres).

- [ ] **Step 9: Remove the old `getCursor`/`saveCursor` from the interface + both adapters**

Delete the declarations from `api/db/adapter.ts`, the methods from `api/db/sqlite.ts` (lines 311–342) and `api/db/postgres.ts`. Any callers still using them will fail TypeScript; they are fixed in Task 3.

- [ ] **Step 10: Commit**

```bash
git add api/db/adapter.ts api/db/sqlite.ts api/db/postgres.ts \
        api/db/sqlite.test.ts api/db/postgres.test.ts
git commit -m "feat(db): add getCursors/saveCursors for tip+backfill persistence"
```

---

## Task 3: Update `IndexerState` for two cursors

**Files:**

- Modify: `indexer/state.ts`
- Modify: `indexer/loop.ts` (only to fix compile errors — loop is still the single-worker loop at this point)
- Modify: `indexer/loop.test.ts`

- [ ] **Step 1: Write failing test**

Add to `indexer/state.test.ts` (create the file if missing):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "bun:test";
import { SQLiteAdapter } from "../api/db/sqlite";
import { IndexerState } from "./state";

describe("IndexerState two-cursor persistence", () => {
  let adapter: SQLiteAdapter | null = null;
  afterEach(async () => {
    if (adapter) await adapter.disconnect();
    adapter = null;
  });

  it("loads fresh defaults on empty DB", async () => {
    adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
    await adapter.connect();
    await adapter.migrate();
    const state = new IndexerState(adapter);
    await state.load();
    expect(state.tipCursor).toEqual({ epoch: null, blockIndex: 0 });
    expect(state.backfillCursor).toEqual({ epoch: null, blockIndex: 0 });
  });

  it("round-trips tip + backfill cursors via save()", async () => {
    adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
    await adapter.connect();
    await adapter.migrate();
    const state = new IndexerState(adapter);
    await state.load();
    state.tipCursor = { epoch: "tip-epoch", blockIndex: 7 };
    state.backfillCursor = { epoch: "bf-epoch", blockIndex: 3 };
    state.etags.nodes = "etag-xyz";
    await state.save();

    const reloaded = new IndexerState(adapter);
    await reloaded.load();
    expect(reloaded.tipCursor).toEqual({ epoch: "tip-epoch", blockIndex: 7 });
    expect(reloaded.backfillCursor).toEqual({ epoch: "bf-epoch", blockIndex: 3 });
    expect(reloaded.etags.nodes).toBe("etag-xyz");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test indexer/state.test.ts`
Expected: FAIL — `state.tipCursor` doesn't exist.

- [ ] **Step 3: Update `IndexerState`**

Replace `indexer/state.ts:41-66`:

```ts
export class IndexerState {
  tipCursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  backfillCursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  etags: EtagState = { nodes: null };
  stall: StallTracker = { lastObserved: null, lastAdvanceAtMs: 0, lastWarnAtMs: 0 };
  observability: ObservabilityCache = { lastBlockInsertAt: null };
  // Cache of epoch → block_1.block_hash. Used to test chain membership
  // (epochs sharing a block_1 hash are on the same chain). Not persisted:
  // rebuilding is cheap (one /block fetch per epoch) and the node is the
  // source of truth, so staleness across restarts is fine.
  chainAnchors: Map<EpochId, string> = new Map();

  constructor(private readonly db: DatabaseAdapter) {}

  async load(): Promise<void> {
    const { tip, backfill } = await this.db.getCursors();
    this.tipCursor = tip;
    this.backfillCursor = backfill;
    this.etags = await this.db.getEtags();
    // Carry forward lastBlockInsertAt across restarts so the UI doesn't
    // flip to "never indexed" for a few seconds after every deploy.
    const prior = await this.db.getIndexerObservability();
    if (prior) this.observability.lastBlockInsertAt = prior.lastBlockInsertAt;
  }

  async save(): Promise<void> {
    await this.db.saveCursors(this.tipCursor, this.backfillCursor, { nodes: this.etags.nodes });
  }
}
```

- [ ] **Step 4: Fix compile errors in `indexer/loop.ts`**

`indexer/loop.ts` still references `state.cursor`. Until we split into tip/backfill workers (Task 7+), rebind it to `state.tipCursor` so the existing single-loop keeps compiling. Replace every `state.cursor` with `state.tipCursor` throughout `indexer/loop.ts` (including the observability write at line 120, which becomes `tipEpoch: state.tipCursor.epoch` / `tipBlockIndex: state.tipCursor.blockIndex`). Also rename in `indexer/loop.test.ts`.

This is a transitional state — `loop.ts` remains correct for a single-cursor walk until Task 8 deletes it.

- [ ] **Step 5: Run state tests — expect PASS**

Run: `bun test indexer/state.test.ts`
Expected: both tests pass.

- [ ] **Step 6: Run full suite — expect PASS**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add indexer/state.ts indexer/state.test.ts indexer/loop.ts indexer/loop.test.ts
git commit -m "feat(indexer): split state cursor into tipCursor and backfillCursor"
```

---

## Task 4: Extend `ChainHealth` with `stage` and `detail`

**Files:**

- Modify: `src/lib/staleness.ts`
- Modify: `src/lib/staleness.test.ts`

- [ ] **Step 1: Write failing tests for the new derivation**

Add to `src/lib/staleness.test.ts` after the existing block:

```ts
describe("computeChainHealth — stage derivation", () => {
  const now = 1_800_000_000_000;

  it("stage='connecting' when indexer is null", () => {
    const h = computeChainHealth({ nowMs: now, tipBlockTimestampMs: null, indexer: null });
    expect(h.stage).toBe("connecting");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBe("Connecting to node…");
  });

  it("stage='stalled' when heartbeat is stale", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ lastStatusFetchAt: new Date(now - 6 * 60_000).toISOString() }),
    });
    expect(h.stage).toBe("stalled");
    expect(h.level).toBe("stalled");
    expect(h.detail).toMatch(/6m/);
  });

  it("stage='synchronizing' + detail='N blocks behind' when tip lags on same epoch", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ nodeLatestBlockIndex: 25, tipBlockIndex: 11 }),
    });
    expect(h.stage).toBe("synchronizing");
    expect(h.detail).toBe("14 blocks behind");
    expect(h.tipLagBlocks).toBe(14);
  });

  it("stage='synchronizing' + detail='Catching up to new epoch' on epoch mismatch", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ nodeLatestEpoch: "newA", tipEpoch: "oldB" }),
    });
    expect(h.stage).toBe("synchronizing");
    expect(h.detail).toBe("Catching up to new epoch");
    expect(h.tipLagBlocks).toBeNull();
  });

  it("stage='backfilling' when tip is caught up but backfill is running", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ backfillEpoch: "some-epoch", backfillBlockIndex: 5 }),
    });
    expect(h.stage).toBe("backfilling");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBeNull();
  });

  it("stage='caught_up' when tip current and backfill idle", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs(),
    });
    expect(h.stage).toBe("caught_up");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBeNull();
  });
});
```

Also update every existing test that uses `indexerLagBlocks` to use `tipLagBlocks`. Update the `obs()` helper at line 15 to use new-shape fields (tipEpoch/tipBlockIndex/backfillEpoch/backfillBlockIndex).

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/lib/staleness.test.ts -t "stage derivation"`
Expected: FAIL — no `stage` on the health object.

- [ ] **Step 3: Rewrite `computeChainHealth`**

Replace `src/lib/staleness.ts:1-169` entirely (see spec section "UI" and the precedence table for semantics). Key structural change: the function now returns `stage` and `detail` alongside existing `level`/`reason`/`blockAgeMs`/`tipLagBlocks` (renamed from `indexerLagBlocks`).

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IndexerObservability } from "../types/telemetry";

export type HealthLevel = "healthy" | "warning" | "stalled";
export type SyncStage = "connecting" | "synchronizing" | "backfilling" | "caught_up" | "stalled";

export interface ChainHealth {
  level: HealthLevel;
  reason: string;
  stage: SyncStage;
  detail: string | null;
  blockAgeMs: number | null;
  tipLagBlocks: number | null;
}

export interface ChainHealthInputs {
  nowMs: number;
  tipBlockTimestampMs: number | null;
  indexer: IndexerObservability | null;
}

const WARN_BLOCK_AGE_MS = 30 * 60 * 1000;
const STALLED_BLOCK_AGE_MS = 2 * 60 * 60 * 1000;
const INDEXER_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function computeChainHealth(inputs: ChainHealthInputs): ChainHealth {
  const { nowMs, tipBlockTimestampMs, indexer } = inputs;
  const blockAgeMs = tipBlockTimestampMs !== null ? nowMs - tipBlockTimestampMs : null;
  const sameEpoch = indexer !== null && indexer.tipEpoch === indexer.nodeLatestEpoch;
  const tipLagBlocks =
    indexer !== null && sameEpoch ? indexer.nodeLatestBlockIndex - indexer.tipBlockIndex : null;

  // 1. Connecting — no poll has completed yet.
  if (indexer === null) {
    return {
      level: "healthy",
      reason: "",
      stage: "connecting",
      detail: "Connecting to node…",
      blockAgeMs,
      tipLagBlocks: null,
    };
  }

  // 2. Heartbeat-stale — precedes every other check because a dead indexer's
  // last-written cursor can equal its last-observed node tip (= looks caught-up).
  const heartbeatMs = Date.parse(indexer.lastStatusFetchAt);
  if (Number.isFinite(heartbeatMs)) {
    const heartbeatAgeMs = nowMs - heartbeatMs;
    if (heartbeatAgeMs >= INDEXER_HEARTBEAT_STALE_MS) {
      const mins = Math.max(1, Math.floor(heartbeatAgeMs / 60_000));
      return {
        level: "stalled",
        reason: `Dashboard indexer hasn't polled the node in ${formatApproxDuration(heartbeatAgeMs)}.`,
        stage: "stalled",
        detail: `${mins}m`,
        blockAgeMs,
        tipLagBlocks,
      };
    }
  }

  // Clock skew: future-dated tip. Don't fire stalled/warning on a negative
  // blockAgeMs — it's almost always client clock drift.
  if (blockAgeMs !== null && (!Number.isFinite(blockAgeMs) || blockAgeMs < 0)) {
    // Still decide stage/detail below using indexer fields only.
  }

  // 3. Tip on a different epoch than the node.
  if (indexer.tipEpoch !== null && indexer.tipEpoch !== indexer.nodeLatestEpoch) {
    return {
      level: "warning",
      reason: "Indexer catching up to a new epoch from the node.",
      stage: "synchronizing",
      detail: "Catching up to new epoch",
      blockAgeMs,
      tipLagBlocks: null,
    };
  }

  // 3b. Same-epoch lag.
  if (tipLagBlocks !== null && tipLagBlocks > 0) {
    return {
      level: "warning",
      reason: `Indexer is ${tipLagBlocks} block${tipLagBlocks === 1 ? "" : "s"} behind the polled node.`,
      stage: "synchronizing",
      detail: `${tipLagBlocks} block${tipLagBlocks === 1 ? "" : "s"} behind`,
      blockAgeMs,
      tipLagBlocks,
    };
  }

  // 4. Backfill in flight.
  if (indexer.backfillEpoch !== null) {
    return {
      level: "healthy",
      reason: "",
      stage: "backfilling",
      detail: null,
      blockAgeMs,
      tipLagBlocks,
    };
  }

  // 5. Tip caught up, backfill idle. Existing block-age thresholds still
  // produce the warning/stalled level for an actually-dead node.
  if (blockAgeMs !== null && Number.isFinite(blockAgeMs) && blockAgeMs >= 0) {
    if (blockAgeMs >= STALLED_BLOCK_AGE_MS) {
      return {
        level: "stalled",
        reason: `Polled node hasn't seen a block in ${formatApproxDuration(blockAgeMs)}.`,
        stage: "caught_up", // the *indexer* is fine; the node isn't producing
        detail: null,
        blockAgeMs,
        tipLagBlocks,
      };
    }
    if (blockAgeMs >= WARN_BLOCK_AGE_MS) {
      return {
        level: "warning",
        reason: `Last block was ${formatApproxDuration(blockAgeMs)} ago.`,
        stage: "caught_up",
        detail: null,
        blockAgeMs,
        tipLagBlocks,
      };
    }
  }

  return {
    level: "healthy",
    reason: "",
    stage: "caught_up",
    detail: null,
    blockAgeMs,
    tipLagBlocks,
  };
}

function formatApproxDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
```

Note: when tip is caught up and `backfillEpoch !== null`, `stage === "backfilling"` overrides the block-age thresholds — a node not producing while backfill is in flight is still reported as `healthy` at the indicator level. The `RecentBlocksTable` banner still surfaces the real node-age via `blockAgeMs` when the stage transitions back to `caught_up`.

- [ ] **Step 4: Run staleness tests — expect PASS**

Run: `bun test src/lib/staleness.test.ts`
Expected: all existing + new tests pass.

- [ ] **Step 5: Run full suite — expect PASS**

Run: `bun test`

- [ ] **Step 6: Commit**

```bash
git add src/lib/staleness.ts src/lib/staleness.test.ts
git commit -m "feat(staleness): derive SyncStage + detail for indicator"
```

---

## Task 5: Add `backfillIdleRecheckSec` config knob

**Files:**

- Modify: `indexer/config.ts`
- Modify: `indexer/config.test.ts`

- [ ] **Step 1: Write failing test**

Add to `indexer/config.test.ts`:

```ts
it("parses --backfill-idle-recheck flag", () => {
  const cfg = parseConfig(["--backfill-idle-recheck", "120"]);
  expect(cfg.backfillIdleRecheckSec).toBe(120);
});

it("reads BACKFILL_IDLE_RECHECK_SEC env var", () => {
  const orig = process.env.BACKFILL_IDLE_RECHECK_SEC;
  process.env.BACKFILL_IDLE_RECHECK_SEC = "60";
  try {
    const cfg = parseConfig([]);
    expect(cfg.backfillIdleRecheckSec).toBe(60);
  } finally {
    if (orig === undefined) delete process.env.BACKFILL_IDLE_RECHECK_SEC;
    else process.env.BACKFILL_IDLE_RECHECK_SEC = orig;
  }
});

it("defaults backfillIdleRecheckSec to 300", () => {
  const cfg = parseConfig([]);
  expect(cfg.backfillIdleRecheckSec).toBe(300);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test indexer/config.test.ts -t "backfill-idle"`
Expected: FAIL — `backfillIdleRecheckSec` missing on config.

- [ ] **Step 3: Add the knob**

In `indexer/config.ts`:

- In `IndexerConfig` interface, add:
  ```ts
  // Interval (seconds) the backfill worker sleeps between plan re-checks when
  // idle (plan fully indexed). Guards against a chain that was the tip mid-walk
  // and became a dead fork before being fully indexed.
  backfillIdleRecheckSec: number;
  ```
- In `DEFAULTS`, add: `backfillIdleRecheckSec: 300,`
- In `parseConfig`, add parsing:
  ```ts
  const backfillIdleFlag = takeFlag(argv, "--backfill-idle-recheck");
  const backfillIdleRecheckSec =
    typeof backfillIdleFlag === "string"
      ? parseIntStrict("--backfill-idle-recheck", backfillIdleFlag)
      : process.env.BACKFILL_IDLE_RECHECK_SEC
        ? parseIntStrict("BACKFILL_IDLE_RECHECK_SEC", process.env.BACKFILL_IDLE_RECHECK_SEC)
        : DEFAULTS.backfillIdleRecheckSec;
  if (backfillIdleRecheckSec <= 0) {
    throw new Error(
      `[indexer] --backfill-idle-recheck must be > 0, got: ${backfillIdleRecheckSec}`,
    );
  }
  ```
- Include `backfillIdleRecheckSec` in the returned object.

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test indexer/config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add indexer/config.ts indexer/config.test.ts
git commit -m "feat(indexer): add backfillIdleRecheckSec config knob (default 300s)"
```

---

## Task 6: Extract shared helpers into `indexer/shared.ts`

**Files:**

- Create: `indexer/shared.ts`
- Modify: `indexer/loop.ts` (re-export for interim continuity)

Pure code motion — no behavior changes. Functions to move: `updateStallTracker`, `maybeWarnStalled`, `isNodeStalled`, `buildCanonicalPlan`, `ensureChainAnchor`, `resolveSelfAddress`, `refreshSelfAddress`, `formatErr`, `logPrefix`, `defaultSleep`. Plus types: `CanonicalEpoch`, `LoopDeps` (rename to `WorkerDeps`), `IterationResult` (kept only if used by both workers — verify and simplify).

- [ ] **Step 1: Write test asserting the module exports**

Add to `indexer/shared.test.ts` (new file):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import {
  buildCanonicalPlan,
  ensureChainAnchor,
  isNodeStalled,
  maybeWarnStalled,
  updateStallTracker,
  formatErr,
  type CanonicalEpoch,
  type WorkerDeps,
} from "./shared";

describe("indexer/shared module", () => {
  it("exports expected functions and types", () => {
    expect(typeof buildCanonicalPlan).toBe("function");
    expect(typeof ensureChainAnchor).toBe("function");
    expect(typeof isNodeStalled).toBe("function");
    expect(typeof maybeWarnStalled).toBe("function");
    expect(typeof updateStallTracker).toBe("function");
    expect(typeof formatErr).toBe("function");
    // compile-time check — types only
    const _a: CanonicalEpoch = { epoch: "x", chainAnchor: "y", ownedStart: 1, ownedEnd: 2 };
    const _b: Partial<WorkerDeps> = {};
    expect(_a.epoch).toBe("x");
    expect(_b).toBeDefined();
  });

  it("isNodeStalled returns true at the exact threshold", () => {
    expect(isNodeStalled(1000, 1000)).toBe(true);
    expect(isNodeStalled(999, 1000)).toBe(false);
  });
});
```

Also move every existing `loop.test.ts` test that exercises `buildCanonicalPlan`, `updateStallTracker`, `maybeWarnStalled`, or `isNodeStalled` into `indexer/shared.test.ts`. Update imports to come from `./shared`.

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test indexer/shared.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `indexer/shared.ts`**

Cut the function bodies + types from `indexer/loop.ts` (lines 29–34, 54–66, 316–538) and paste them into `indexer/shared.ts`. Add the SPDX header. Rename `LoopDeps` → `WorkerDeps`. Keep signatures identical. Re-export from `loop.ts` for now so callers aren't broken:

```ts
// indexer/loop.ts — top of file
export * from "./shared";
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test indexer/shared.test.ts`

- [ ] **Step 5: Run full suite — expect PASS**

Run: `bun test`

- [ ] **Step 6: Commit**

```bash
git add indexer/shared.ts indexer/shared.test.ts indexer/loop.ts indexer/loop.test.ts
git commit -m "refactor(indexer): extract shared helpers into shared.ts"
```

---

## Task 7: Create the tip worker

**Files:**

- Create: `indexer/tip-worker.ts`
- Create: `indexer/tip-worker.test.ts`

The tip worker is the tight loop described in the spec's "Workflows · Tip worker loop" section. It owns `/status` polling, stall tracking, `replaceEpochStatus`, nodes-snapshot refresh, self-address resolution, and indexing the current tip epoch's owned range only.

- [ ] **Step 1: Write failing tests covering the core behaviors**

Create `indexer/tip-worker.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
// Import or re-use the FakeDb / FakeClient harness from loop.test.ts — see
// indexer/loop.test.ts lines 8-200 for the existing pattern. Move the helper
// types to indexer/test-helpers.ts and import from both test files.
import { makeFakeDb, makeFakeClient, type FakeClient, type FakeDb } from "./test-helpers";
import { runTipIteration } from "./tip-worker";
import { IndexerState } from "./state";

const CONFIG = {
  nodeUrl: "http://x",
  token: undefined,
  pollIntervalSec: 8,
  nodesRefreshSec: 45,
  backfillFromEpoch: undefined,
  once: false,
  verbose: false,
  stallWarnAfterSec: 600,
  backfillIdleRecheckSec: 300,
} as const;

describe("runTipIteration", () => {
  it("seeds tipCursor from ownedStart on first poll when epoch has prior on same chain", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tipA", latestBlockIndex: 102 },
      epochs: [
        { epoch: "priorA", status: "live", lastBlock: 100 }, // prior on same chain
        { epoch: "tipA", status: "live", lastBlock: 102 },
      ],
      // Both epochs resolve to the same chain anchor via block-1 hash.
      blockByHash: { priorA_1: "chainX", tipA_1: "chainX" },
    });
    const state = new IndexerState(db);
    await state.load();

    await runTipIteration({ config: CONFIG, client, db, state }, Date.now());

    // ownedStart(tipA) = priorA.lastBlock + 1 = 101. Fetched blocks: 101, 102.
    expect(state.tipCursor).toEqual({ epoch: "tipA", blockIndex: 102 });
    expect(
      db.blocks
        .filter((b) => b.epoch === "tipA")
        .map((b) => b.blockIndex)
        .sort(),
    ).toEqual([101, 102]);
  });

  it("resets tipCursor on epoch rollover", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tipB", latestBlockIndex: 50 },
      epochs: [
        { epoch: "tipA", status: "stale_fork", lastBlock: 49 },
        { epoch: "tipB", status: "live", lastBlock: 50 },
      ],
      blockByHash: { tipA_1: "chain1", tipB_1: "chain1" },
    });
    const state = new IndexerState(db);
    state.tipCursor = { epoch: "tipA", blockIndex: 49 };

    await runTipIteration({ config: CONFIG, client, db, state }, Date.now());

    expect(state.tipCursor.epoch).toBe("tipB");
    expect(state.tipCursor.blockIndex).toBe(50);
  });

  it("walks new same-epoch blocks without re-fetching", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tipA", latestBlockIndex: 105 },
      epochs: [{ epoch: "tipA", status: "live", lastBlock: 105 }],
      blockByHash: { tipA_1: "chain1" },
    });
    const state = new IndexerState(db);
    state.tipCursor = { epoch: "tipA", blockIndex: 102 };

    await runTipIteration({ config: CONFIG, client, db, state }, Date.now());

    expect(client.getBlockCalls.filter((c) => c.epoch === "tipA").map((c) => c.index)).toEqual([
      103, 104, 105,
    ]);
    expect(state.tipCursor.blockIndex).toBe(105);
  });

  it("writes observability (heartbeat) even when /status returns no body", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({ status: null, epochs: [] });
    const state = new IndexerState(db);

    const nowMs = 1_700_000_000_000;
    await runTipIteration({ config: CONFIG, client, db, state }, nowMs);

    expect(db.observability).not.toBeNull();
    expect(db.observability!.lastStatusFetchAt).toBe(new Date(nowMs).toISOString());
  });

  it("calls replaceEpochStatus with every /epochs entry", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tipA", latestBlockIndex: 1 },
      epochs: [
        { epoch: "tipA", status: "live", lastBlock: 1 },
        { epoch: "deadA", status: "stale_fork", lastBlock: 8 },
      ],
      blockByHash: { tipA_1: "chainA" },
    });
    const state = new IndexerState(db);
    await runTipIteration({ config: CONFIG, client, db, state }, Date.now());

    const epochStatusRows = db.epochStatus.slice().sort((a, b) => a.epoch.localeCompare(b.epoch));
    expect(epochStatusRows).toEqual([
      { epoch: "deadA", status: "stale_fork" },
      { epoch: "tipA", status: "live" },
    ]);
  });

  it("advances stall tracker when node tip moves", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tipA", latestBlockIndex: 100 },
      epochs: [{ epoch: "tipA", status: "live", lastBlock: 100 }],
      blockByHash: { tipA_1: "chain1" },
    });
    const state = new IndexerState(db);
    state.stall.lastObserved = { epoch: "tipA", blockIndex: 99 };
    state.stall.lastAdvanceAtMs = 1000;

    await runTipIteration({ config: CONFIG, client, db, state }, 5000);

    expect(state.stall.lastObserved).toEqual({ epoch: "tipA", blockIndex: 100 });
    expect(state.stall.lastAdvanceAtMs).toBe(5000);
  });
});
```

(The `test-helpers` file factoring the existing `loop.test.ts` harness is created as part of this task; move the `FakeDb` / `FakeClient` implementations out of `loop.test.ts` into `indexer/test-helpers.ts` and import from both `tip-worker.test.ts` and `backfill-worker.test.ts`.)

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test indexer/tip-worker.test.ts`
Expected: FAIL — `./tip-worker` module not found.

- [ ] **Step 3: Create `indexer/tip-worker.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import { rawBlockToRecord, rawNodesToSnapshot } from "../api/db/adapter";
import type { EpochId } from "../src/types/telemetry";

import {
  AuthError,
  RateLimitError,
  type EpochsBody,
  type StatusBody,
  type QuipClient,
} from "./client";
import type { IndexerConfig } from "./config";
import {
  ensureChainAnchor,
  formatErr,
  logPrefix,
  maybeWarnStalled,
  refreshSelfAddress,
  updateStallTracker,
  type WorkerDeps,
} from "./shared";
import type { IndexerState } from "./state";

const log = logPrefix("log");
const warn = logPrefix("warn");
const error = logPrefix("error");

export interface TipIterationResult {
  fetchedStatus: boolean;
  blocksIndexed: number;
  blocksSkipped: number;
  nodesRefreshed: boolean;
}

/**
 * One tip-worker iteration. Separated from {@link runTipLoop} so tests can
 * exercise the single-iteration behavior without driving the full loop.
 */
export async function runTipIteration(
  deps: WorkerDeps,
  nowMs: number,
  lastNodesFetchMs: { value: number } = { value: 0 },
): Promise<TipIterationResult> {
  const { client, db, state, config } = deps;
  const result: TipIterationResult = {
    fetchedStatus: false,
    blocksIndexed: 0,
    blocksSkipped: 0,
    nodesRefreshed: false,
  };

  const statusRes = await client.getStatus(null);
  result.fetchedStatus = true;

  const writeObservability = async (): Promise<void> => {
    try {
      await db.setIndexerObservability({
        nodeLatestEpoch: statusRes.body?.latestEpoch ?? state.tipCursor.epoch ?? "",
        nodeLatestBlockIndex: statusRes.body?.latestBlockIndex ?? 0,
        tipEpoch: state.tipCursor.epoch,
        tipBlockIndex: state.tipCursor.blockIndex,
        backfillEpoch: state.backfillCursor.epoch,
        backfillBlockIndex: state.backfillCursor.blockIndex,
        lastStatusFetchAt: new Date(nowMs).toISOString(),
        lastBlockInsertAt: state.observability.lastBlockInsertAt,
      });
    } catch (e) {
      warn(`setIndexerObservability failed: ${formatErr(e)}`);
    }
  };

  if (!statusRes.body) {
    await writeObservability();
    return result;
  }

  const status = statusRes.body;
  updateStallTracker(state, status, nowMs);
  maybeWarnStalled(state, config, nowMs);

  try {
    const epochsBody = await client.getEpochs();
    try {
      await db.replaceEpochStatus(
        epochsBody.epochs.map((e) => ({ epoch: e.epoch, status: e.status })),
      );
    } catch (e) {
      warn(`replaceEpochStatus failed: ${formatErr(e)}`);
    }

    const ownedStart = await computeTipOwnedStart(client, state, status, epochsBody);
    if (ownedStart !== null) {
      if (state.tipCursor.epoch !== status.latestEpoch) {
        state.tipCursor = { epoch: status.latestEpoch, blockIndex: ownedStart - 1 };
      }

      while (state.tipCursor.blockIndex < status.latestBlockIndex) {
        const idx = state.tipCursor.blockIndex + 1;
        let raw: Record<string, unknown> | null;
        try {
          raw = await client.getBlock(status.latestEpoch, idx);
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
          error(`tip block fetch failed at ${status.latestEpoch}/${idx}: ${formatErr(e)}`);
          break;
        }
        if (raw === null) {
          warn(`tip block ${status.latestEpoch}/${idx} returned 404, skipping`);
          state.tipCursor.blockIndex = idx;
          result.blocksSkipped += 1;
          continue;
        }
        const record = rawBlockToRecord(
          raw as unknown as Parameters<typeof rawBlockToRecord>[0],
          status.latestEpoch,
        );
        await db.insertBlock(record);
        state.tipCursor.blockIndex = idx;
        state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
        result.blocksIndexed += 1;
      }
    }

    // Nodes snapshot refresh + self-address resolution on its own cadence.
    const sinceNodesMs = nowMs - lastNodesFetchMs.value;
    if (sinceNodesMs >= config.nodesRefreshSec * 1000) {
      try {
        const nodesRes = await client.getNodes(state.etags.nodes);
        if (nodesRes.status !== 304 && nodesRes.body) {
          const snapshot = rawNodesToSnapshot(
            nodesRes.body as unknown as Parameters<typeof rawNodesToSnapshot>[0],
          );
          await db.upsertNodes(snapshot);
          if (nodesRes.etag) state.etags.nodes = nodesRes.etag;
          await refreshSelfAddress(db, client, snapshot);
          result.nodesRefreshed = true;
          if (config.verbose) log(`refreshed nodes: ${snapshot.nodeCount} total`);
        }
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        warn(`nodes fetch failed: ${formatErr(e)}`);
      }
      lastNodesFetchMs.value = nowMs;
    }

    await state.save();
  } finally {
    await writeObservability();
  }

  return result;
}

/**
 * Compute the owned-range start for the node's current tip epoch, using the
 * same per-chain arithmetic as buildCanonicalPlan but scoped to a single epoch.
 * Returns null if the tip epoch has no block 1 indexed yet (very early bootstrap
 * or transient 404) — the caller should skip indexing this iteration.
 */
export async function computeTipOwnedStart(
  client: QuipClient,
  state: IndexerState,
  status: StatusBody,
  epochsBody: EpochsBody,
): Promise<number | null> {
  if (status.latestBlockIndex <= 0) return null;
  const tipAnchor = await ensureChainAnchor(client, state, status.latestEpoch);
  if (!tipAnchor) return null;

  // Find the largest lastBlock of any *other* epoch on the same chain with
  // lastBlock < status.latestBlockIndex. ownedStart = that + 1 (or 1 if none).
  let prevLast = 0;
  for (const e of epochsBody.epochs) {
    if (e.epoch === status.latestEpoch) continue;
    if (e.lastBlock <= 0 || e.lastBlock >= status.latestBlockIndex) continue;
    const anchor = await ensureChainAnchor(client, state, e.epoch);
    if (anchor !== tipAnchor) continue;
    if (e.lastBlock > prevLast) prevLast = e.lastBlock;
  }
  return prevLast + 1;
}

/**
 * Run the tip worker until {@link signal} is aborted. Handles 429 backoff
 * per-worker (isolated from the backfill worker's rate-limit state). AuthError
 * propagates to the caller (main.ts) for process exit.
 */
export async function runTipLoop(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  const { config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const lastNodesFetch = { value: 0 };
  let backoffMs = 0;

  while (!signal.aborted) {
    try {
      const r = await runTipIteration(deps, now(), lastNodesFetch);
      backoffMs = 0;
      if (config.verbose) {
        log(
          `[tip] indexed=${r.blocksIndexed} skipped=${r.blocksSkipped} nodes=${r.nodesRefreshed}`,
        );
      }
      if (config.once) return;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e instanceof RateLimitError) {
        backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
        warn(`[tip] rate limited, backing off ${backoffMs}ms`);
        try {
          await sleep(backoffMs);
        } catch {
          /* aborted */
        }
        if (config.once) throw e;
        continue;
      }
      error(`[tip] iteration failed: ${formatErr(e)}`);
      if (config.once) throw e;
    }
    try {
      await sleep(config.pollIntervalSec * 1000);
    } catch {
      /* aborted */
    }
  }
}
```

- [ ] **Step 4: Run tip-worker tests — expect PASS**

Run: `bun test indexer/tip-worker.test.ts`

- [ ] **Step 5: Run full suite — expect PASS**

Run: `bun test`

- [ ] **Step 6: Commit**

```bash
git add indexer/tip-worker.ts indexer/tip-worker.test.ts indexer/test-helpers.ts \
        indexer/loop.test.ts
git commit -m "feat(indexer): add tip-worker module with tight-loop tip indexing"
```

---

## Task 8: Create the backfill worker

**Files:**

- Create: `indexer/backfill-worker.ts`
- Create: `indexer/backfill-worker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `indexer/backfill-worker.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import { makeFakeDb, makeFakeClient } from "./test-helpers";
import { reorderCanonicalFirst, runBackfillIteration } from "./backfill-worker";
import { IndexerState } from "./state";
import type { CanonicalEpoch } from "./shared";

const CONFIG = {
  nodeUrl: "http://x",
  token: undefined,
  pollIntervalSec: 8,
  nodesRefreshSec: 45,
  backfillFromEpoch: undefined,
  once: false,
  verbose: false,
  stallWarnAfterSec: 600,
  backfillIdleRecheckSec: 300,
} as const;

describe("reorderCanonicalFirst", () => {
  it("puts canonical-chain entries before dead-fork entries", () => {
    const plan: CanonicalEpoch[] = [
      { epoch: "deadA", chainAnchor: "aaaa", ownedStart: 1, ownedEnd: 5 },
      { epoch: "liveA", chainAnchor: "zzzz", ownedStart: 1, ownedEnd: 10 },
      { epoch: "deadB", chainAnchor: "bbbb", ownedStart: 1, ownedEnd: 3 },
    ];
    const reordered = reorderCanonicalFirst(plan, "liveA");
    expect(reordered.map((e) => e.epoch)).toEqual(["liveA", "deadA", "deadB"]);
  });
  it("preserves ownedStart order within each partition", () => {
    const plan: CanonicalEpoch[] = [
      { epoch: "live2", chainAnchor: "zzzz", ownedStart: 6, ownedEnd: 10 },
      { epoch: "live1", chainAnchor: "zzzz", ownedStart: 1, ownedEnd: 5 },
    ];
    const reordered = reorderCanonicalFirst(plan, "live2");
    expect(reordered.map((e) => e.epoch)).toEqual(["live1", "live2"]);
  });
});

describe("runBackfillIteration", () => {
  it("skips the tip epoch in the filtered plan", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tip", latestBlockIndex: 10 },
      epochs: [
        { epoch: "tip", status: "live", lastBlock: 10 },
        { epoch: "prior", status: "stale_fork", lastBlock: 5 },
      ],
      blockByHash: { tip_1: "chainA", prior_1: "chainA" },
    });
    const state = new IndexerState(db);
    await runBackfillIteration({ config: CONFIG, client, db, state }, Date.now());

    // Should have indexed prior's range [1..5], never requested tip.
    expect(client.getBlockCalls.some((c) => c.epoch === "tip")).toBe(false);
    expect(db.blocks.map((b) => `${b.epoch}/${b.blockIndex}`).sort()).toEqual([
      "prior/1",
      "prior/2",
      "prior/3",
      "prior/4",
      "prior/5",
    ]);
  });

  it("sets backfillCursor epoch null when plan is empty (idle)", async () => {
    const db = makeFakeDb();
    const client = makeFakeClient({
      status: { latestEpoch: "tip", latestBlockIndex: 10 },
      epochs: [{ epoch: "tip", status: "live", lastBlock: 10 }],
      blockByHash: { tip_1: "chainA" },
    });
    const state = new IndexerState(db);
    state.backfillCursor = { epoch: "ghost", blockIndex: 99 };
    await runBackfillIteration({ config: CONFIG, client, db, state }, Date.now());
    expect(state.backfillCursor).toEqual({ epoch: null, blockIndex: 0 });
  });

  it("resumes at an already-indexed plan entry without re-fetching", async () => {
    const db = makeFakeDb();
    db.blocks.push(
      { epoch: "prior", blockIndex: 1 } as any,
      { epoch: "prior", blockIndex: 2 } as any,
      { epoch: "prior", blockIndex: 3 } as any,
    );
    const client = makeFakeClient({
      status: { latestEpoch: "tip", latestBlockIndex: 10 },
      epochs: [
        { epoch: "tip", status: "live", lastBlock: 10 },
        { epoch: "prior", status: "stale_fork", lastBlock: 5 },
      ],
      blockByHash: { tip_1: "chainA", prior_1: "chainA" },
    });
    const state = new IndexerState(db);
    await runBackfillIteration({ config: CONFIG, client, db, state }, Date.now());

    // Blocks 1-3 already present; backfiller only fetches 4, 5.
    const priorCalls = client.getBlockCalls.filter((c) => c.epoch === "prior").map((c) => c.index);
    expect(priorCalls.sort()).toEqual([4, 5]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test indexer/backfill-worker.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `indexer/backfill-worker.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord } from "../api/db/adapter";

import { AuthError, RateLimitError } from "./client";
import {
  buildCanonicalPlan,
  ensureChainAnchor,
  formatErr,
  logPrefix,
  type CanonicalEpoch,
  type WorkerDeps,
} from "./shared";

const log = logPrefix("log");
const warn = logPrefix("warn");
const error = logPrefix("error");

export interface BackfillIterationResult {
  blocksIndexed: number;
  blocksSkipped: number;
  planSize: number;
  idle: boolean;
}

/**
 * Reorder a canonical plan so every epoch sharing the tip's chain anchor
 * comes before every epoch on any other chain. Ordering within each partition
 * preserves the buildCanonicalPlan (ownedStart ascending) arrangement.
 */
export function reorderCanonicalFirst(plan: CanonicalEpoch[], tipEpoch: string): CanonicalEpoch[] {
  const tipEntry = plan.find((e) => e.epoch === tipEpoch);
  if (!tipEntry) return plan.slice();
  const canonical = plan.filter((e) => e.chainAnchor === tipEntry.chainAnchor);
  const dead = plan.filter((e) => e.chainAnchor !== tipEntry.chainAnchor);
  return [...canonical, ...dead];
}

/**
 * One backfill-worker iteration. Rebuilds the plan from /status + /epochs,
 * reorders canonical-first, filters the tip epoch, skips entries whose owned
 * range is fully covered in the blocks table, then walks the first entry that
 * still has work.
 */
export async function runBackfillIteration(
  deps: WorkerDeps,
  nowMs: number,
): Promise<BackfillIterationResult> {
  const { client, db, state, config } = deps;
  const result: BackfillIterationResult = {
    blocksIndexed: 0,
    blocksSkipped: 0,
    planSize: 0,
    idle: false,
  };

  const statusRes = await client.getStatus(null);
  if (!statusRes.body) {
    result.idle = true;
    return result;
  }
  const status = statusRes.body;
  const epochsBody = await client.getEpochs();

  const fullPlan = await buildCanonicalPlan(client, state, status, epochsBody);
  const ordered = reorderCanonicalFirst(fullPlan, status.latestEpoch);
  const plan = ordered.filter((e) => e.epoch !== status.latestEpoch);
  result.planSize = plan.length;

  // markPlanEntriesDone: drop entries whose owned range is fully indexed.
  const undone: CanonicalEpoch[] = [];
  for (const entry of plan) {
    const existing = await db.getBlocksByEpoch(entry.epoch);
    const indexed = new Set(existing.map((b) => b.blockIndex));
    const remaining: number[] = [];
    for (let i = entry.ownedStart; i <= entry.ownedEnd; i++) {
      if (!indexed.has(i)) remaining.push(i);
    }
    if (remaining.length > 0) undone.push(entry);
  }

  if (undone.length === 0) {
    state.backfillCursor = { epoch: null, blockIndex: 0 };
    result.idle = true;
    await state.save();
    return result;
  }

  const next = undone[0]!;
  if (state.backfillCursor.epoch !== next.epoch) {
    state.backfillCursor = { epoch: next.epoch, blockIndex: next.ownedStart - 1 };
  }

  while (state.backfillCursor.blockIndex < next.ownedEnd) {
    const idx = state.backfillCursor.blockIndex + 1;
    let raw: Record<string, unknown> | null;
    try {
      raw = await client.getBlock(next.epoch, idx);
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      error(`[backfill] block fetch failed at ${next.epoch}/${idx}: ${formatErr(e)}`);
      break;
    }
    if (raw === null) {
      warn(`[backfill] block ${next.epoch}/${idx} returned 404, skipping`);
      state.backfillCursor.blockIndex = idx;
      result.blocksSkipped += 1;
      continue;
    }
    const record = rawBlockToRecord(
      raw as unknown as Parameters<typeof rawBlockToRecord>[0],
      next.epoch,
    );
    await db.insertBlock(record);
    state.backfillCursor.blockIndex = idx;
    state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
    result.blocksIndexed += 1;
  }

  await state.save();
  return result;
}

/**
 * Run the backfill worker until {@link signal} is aborted. When the plan is
 * fully indexed, sleep {@link config.backfillIdleRecheckSec} before rebuilding
 * the plan — this catches dead forks exposed after the walk and chains that
 * were tip mid-walk.
 */
export async function runBackfillLoop(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  const { config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let backoffMs = 0;

  while (!signal.aborted) {
    let sleepMs = 0;
    try {
      const r = await runBackfillIteration(deps, now());
      backoffMs = 0;
      sleepMs = r.idle ? config.backfillIdleRecheckSec * 1000 : 0;
      if (config.verbose) {
        log(`[backfill] planSize=${r.planSize} indexed=${r.blocksIndexed} idle=${r.idle}`);
      }
      if (config.once) return;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e instanceof RateLimitError) {
        backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
        warn(`[backfill] rate limited, backing off ${backoffMs}ms`);
        sleepMs = backoffMs;
        if (config.once) throw e;
      } else {
        error(`[backfill] iteration failed: ${formatErr(e)}`);
        sleepMs = config.pollIntervalSec * 1000;
        if (config.once) throw e;
      }
    }
    if (sleepMs > 0) {
      try {
        await sleep(sleepMs);
      } catch {
        /* aborted */
      }
    }
  }
}
```

- [ ] **Step 4: Run backfill-worker tests — expect PASS**

Run: `bun test indexer/backfill-worker.test.ts`

- [ ] **Step 5: Run full suite — expect PASS**

Run: `bun test`

- [ ] **Step 6: Commit**

```bash
git add indexer/backfill-worker.ts indexer/backfill-worker.test.ts
git commit -m "feat(indexer): add backfill-worker with canonical-first plan order"
```

---

## Task 9: Rewrite `main.ts` for two-worker orchestration

**Files:**

- Modify: `indexer/main.ts`
- Create: `indexer/main.test.ts`
- Delete: `indexer/loop.ts`, `indexer/loop.test.ts` (fold residue into `shared.test.ts` if needed)

- [ ] **Step 1: Write failing orchestration test**

Create `indexer/main.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import { AuthError } from "./client";
import { runWorkers } from "./main";

describe("runWorkers", () => {
  it("returns 0 when both workers complete normally (--once)", async () => {
    const tipRan = { value: false };
    const bfRan = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        tipRan.value = true;
      },
      runBackfill: async () => {
        bfRan.value = true;
      },
    });
    expect(code).toBe(0);
    expect(tipRan.value).toBe(true);
    expect(bfRan.value).toBe(true);
  });

  it("returns 1 and aborts the sibling when one worker throws AuthError", async () => {
    const bfAborted = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        throw new AuthError("401");
      },
      runBackfill: async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            bfAborted.value = true;
            resolve();
          });
          setTimeout(() => reject(new Error("timed out without abort")), 500);
        });
      },
    });
    expect(code).toBe(1);
    expect(bfAborted.value).toBe(true);
  });

  it("returns 1 when a non-auth error leaks out (should not happen but defensive)", async () => {
    const code = await runWorkers({
      runTip: async () => {
        throw new Error("boom");
      },
      runBackfill: async () => {
        /* finishes fast */
      },
    });
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test indexer/main.test.ts`
Expected: FAIL — `runWorkers` not exported.

- [ ] **Step 3: Rewrite `indexer/main.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "../api/db";
import { AuthError, QuipClient } from "./client";
import { runBackfillLoop } from "./backfill-worker";
import { parseConfig } from "./config";
import { runTipLoop } from "./tip-worker";
import { IndexerState } from "./state";

export interface WorkerRunner {
  runTip: (signal: AbortSignal) => Promise<void>;
  runBackfill: (signal: AbortSignal) => Promise<void>;
}

/**
 * Run both workers with a shared AbortController. If either throws AuthError,
 * abort the sibling and return exit code 1. Any other non-Abort exception is
 * also treated as fatal (workers are expected to swallow transient errors
 * internally; leaking one means the worker's own error-handling failed).
 */
export async function runWorkers(runners: WorkerRunner): Promise<number> {
  const ac = new AbortController();
  const wrap = async (name: "tip" | "backfill", fn: (s: AbortSignal) => Promise<void>) => {
    try {
      await fn(ac.signal);
    } catch (e) {
      if (e instanceof AuthError) {
        console.error(`[indexer] ${name} auth failed:`, e.message);
        ac.abort();
        throw e;
      }
      if ((e as Error)?.name === "AbortError") return;
      console.error(
        `[indexer] ${name} unhandled error:`,
        e instanceof Error ? (e.stack ?? e.message) : e,
      );
      ac.abort();
      throw e;
    }
  };
  const results = await Promise.allSettled([
    wrap("tip", runners.runTip),
    wrap("backfill", runners.runBackfill),
  ]);
  const failed = results.some((r) => r.status === "rejected");
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const config = parseConfig();
  console.log(
    `[indexer] starting node=${config.nodeUrl} poll=${config.pollIntervalSec}s` +
      ` nodesRefresh=${config.nodesRefreshSec}s stallWarnAfter=${config.stallWarnAfterSec}s` +
      ` backfillIdleRecheck=${config.backfillIdleRecheckSec}s once=${config.once}` +
      (config.backfillFromEpoch !== undefined ? ` backfillFrom=${config.backfillFromEpoch}` : ""),
  );

  const db = await createAdapter();
  await db.connect();
  await db.migrate();

  const tipClient = new QuipClient({ baseUrl: config.nodeUrl, token: config.token });
  const backfillClient = new QuipClient({ baseUrl: config.nodeUrl, token: config.token });
  const state = new IndexerState(db);
  await state.load();

  const onSignal = (sig: string, ac: AbortController) => {
    console.log(`[indexer] received ${sig}, shutting down`);
    ac.abort();
  };
  const ac = new AbortController();
  process.on("SIGINT", () => onSignal("SIGINT", ac));
  process.on("SIGTERM", () => onSignal("SIGTERM", ac));

  let exitCode = 0;
  try {
    exitCode = await runWorkers({
      runTip: (signal) => {
        // chain the process-level abort into the workers-shared abort
        ac.signal.addEventListener("abort", () => signal.dispatchEvent(new Event("abort")));
        return runTipLoop({ config, client: tipClient, db, state }, signal);
      },
      runBackfill: (signal) => {
        ac.signal.addEventListener("abort", () => signal.dispatchEvent(new Event("abort")));
        return runBackfillLoop({ config, client: backfillClient, db, state }, signal);
      },
    });
    await state.save();
  } catch (e) {
    exitCode = 1;
    const label = e instanceof AuthError ? "auth failed" : "workers failed";
    console.error(`[indexer] ${label}:`, e instanceof Error ? (e.stack ?? e.message) : e);
  } finally {
    await db.disconnect();
  }
  console.log("[indexer] stopped");
  return exitCode;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("[indexer] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 4: Delete `indexer/loop.ts` and `indexer/loop.test.ts`**

```bash
git rm indexer/loop.ts indexer/loop.test.ts
```

Any residual tests (e.g. `buildCanonicalPlan` scenarios not yet moved) relocate into `indexer/shared.test.ts`.

- [ ] **Step 5: Run — expect PASS**

Run: `bun test`
Expected: all tests pass; no lingering `loop.ts` imports.

- [ ] **Step 6: Commit**

```bash
git add indexer/main.ts indexer/main.test.ts indexer/shared.test.ts
git commit -m "feat(indexer): orchestrate tip + backfill workers with AbortController"
```

---

## Task 10: Create `<SyncIndicator />` component

**Files:**

- Create: `src/components/layout/SyncIndicator.tsx`
- Create: `src/components/layout/SyncIndicator.test.tsx`
- Modify: `src/store/telemetry-store.ts` (add `selectTipBlockTimestampMs` selector)

- [ ] **Step 1: Add the selector**

In `src/store/telemetry-store.ts`, add below `selectTipBlock`:

```ts
/** Timestamp (ms) of the tip block, or null when no blocks are loaded. */
export function selectTipBlockTimestampMs(s: TelemetryState): number | null {
  const tip = selectTipBlock(s);
  return tip ? tip.timestamp * 1000 : null;
}
```

- [ ] **Step 2: Write failing tests**

Create `src/components/layout/SyncIndicator.test.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, beforeEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { useTelemetryStore } from "../../store/telemetry-store";
import { SyncIndicator } from "./SyncIndicator";

function setStore(indexer: Parameters<typeof useTelemetryStore.setState>[0]) {
  useTelemetryStore.setState({
    blocks: [],
    nodes: null,
    selfAddress: null,
    loading: false,
    error: null,
    ...indexer,
  } as any);
}

describe("SyncIndicator", () => {
  beforeEach(() => cleanup());

  it("renders 'Connecting to node…' when indexer is null", () => {
    setStore({ indexer: null });
    const { getByText } = render(<SyncIndicator />);
    expect(getByText("Connecting to node…")).toBeDefined();
  });

  it("renders 'Live' when caught up", () => {
    setStore({
      indexer: {
        nodeLatestEpoch: "x",
        nodeLatestBlockIndex: 10,
        tipEpoch: "x",
        tipBlockIndex: 10,
        backfillEpoch: null,
        backfillBlockIndex: 0,
        lastStatusFetchAt: new Date().toISOString(),
        lastBlockInsertAt: null,
      },
      blocks: [{ epoch: "x", blockIndex: 10, timestamp: Math.floor(Date.now() / 1000) - 5 } as any],
    });
    const { getByText } = render(<SyncIndicator />);
    expect(getByText("Live")).toBeDefined();
  });

  it("renders 'N blocks behind' when tip is behind on same epoch", () => {
    setStore({
      indexer: {
        nodeLatestEpoch: "x",
        nodeLatestBlockIndex: 10,
        tipEpoch: "x",
        tipBlockIndex: 3,
        backfillEpoch: null,
        backfillBlockIndex: 0,
        lastStatusFetchAt: new Date().toISOString(),
        lastBlockInsertAt: null,
      },
    });
    const { getByText } = render(<SyncIndicator />);
    expect(getByText(/7 blocks behind/)).toBeDefined();
  });

  it("renders 'Backfilling history' when tip caught up and backfill active", () => {
    setStore({
      indexer: {
        nodeLatestEpoch: "x",
        nodeLatestBlockIndex: 10,
        tipEpoch: "x",
        tipBlockIndex: 10,
        backfillEpoch: "dead",
        backfillBlockIndex: 2,
        lastStatusFetchAt: new Date().toISOString(),
        lastBlockInsertAt: null,
      },
    });
    const { getByText } = render(<SyncIndicator />);
    expect(getByText("Backfilling history")).toBeDefined();
  });

  it("renders 'Indexer offline · 7m' when heartbeat is stale", () => {
    setStore({
      indexer: {
        nodeLatestEpoch: "x",
        nodeLatestBlockIndex: 10,
        tipEpoch: "x",
        tipBlockIndex: 10,
        backfillEpoch: null,
        backfillBlockIndex: 0,
        lastStatusFetchAt: new Date(Date.now() - 7 * 60_000).toISOString(),
        lastBlockInsertAt: null,
      },
    });
    const { getByText } = render(<SyncIndicator />);
    expect(getByText(/7m/)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `bun test src/components/layout/SyncIndicator.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 4: Create `src/components/layout/SyncIndicator.tsx`**

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { computeChainHealth, type SyncStage } from "../../lib/staleness";
import { selectTipBlockTimestampMs, useTelemetryStore } from "../../store/telemetry-store";

/** Visual tokens per stage. Keys are the SyncStage enum values. */
const STYLES: Record<
  SyncStage,
  {
    bg: string;
    border: string;
    text: string;
    dotColor: string;
    dotAnim: "pulse" | "spin" | "static";
  }
> = {
  connecting: {
    bg: "bg-[#A9A9A9]/10",
    border: "border-[#A9A9A9]/40",
    text: "text-[#A9A9A9]",
    dotColor: "#A9A9A9",
    dotAnim: "spin",
  },
  synchronizing: {
    bg: "bg-[#4CE0FF]/10",
    border: "border-[#4CE0FF]/40",
    text: "text-[#4CE0FF]",
    dotColor: "#4CE0FF",
    dotAnim: "pulse",
  },
  backfilling: {
    bg: "bg-[#F5A623]/10",
    border: "border-[#F5A623]/40",
    text: "text-[#F5A623]",
    dotColor: "#F5A623",
    dotAnim: "pulse",
  },
  caught_up: {
    bg: "bg-[#67E347]/10",
    border: "border-[#67E347]/40",
    text: "text-[#67E347]",
    dotColor: "#67E347",
    dotAnim: "static",
  },
  stalled: {
    bg: "bg-[#E34735]/10",
    border: "border-[#E34735]/60",
    text: "text-[#E34735]",
    dotColor: "#E34735",
    dotAnim: "static",
  },
};

const LABELS: Record<SyncStage, string> = {
  connecting: "Connecting to node…",
  synchronizing: "Synchronizing",
  backfilling: "Backfilling history",
  caught_up: "Live",
  stalled: "Indexer offline",
};

export function SyncIndicator() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const tipBlockTimestampMs = useTelemetryStore(selectTipBlockTimestampMs);

  const health = useMemo(
    () => computeChainHealth({ nowMs: Date.now(), tipBlockTimestampMs, indexer }),
    [indexer, tipBlockTimestampMs],
  );

  const style = STYLES[health.stage];
  const label = LABELS[health.stage];
  const detail = health.detail;

  // Compose final copy. Stages with a non-null detail show "label · detail"
  // except for "Connecting" where the label itself is the message, and
  // "Backfilling"/"Live" where detail is null.
  const text = health.stage === "connecting" ? label : detail ? `${label} · ${detail}` : label;

  const dotClass =
    style.dotAnim === "spin" ? "animate-spin" : style.dotAnim === "pulse" ? "animate-pulse" : "";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-[5px] font-accent text-[11px] ${style.bg} ${style.border} ${style.text}`}
      role="status"
      aria-live="polite"
    >
      {style.dotAnim === "spin" ? (
        <span
          className={`inline-block h-[10px] w-[10px] rounded-full border-2 border-t-transparent ${dotClass}`}
          style={{ borderColor: style.dotColor, borderTopColor: "transparent" }}
        />
      ) : (
        <span
          className={`inline-block h-[7px] w-[7px] rounded-full ${dotClass}`}
          style={{ backgroundColor: style.dotColor }}
        />
      )}
      {text}
    </span>
  );
}
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `bun test src/components/layout/SyncIndicator.test.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/SyncIndicator.tsx \
        src/components/layout/SyncIndicator.test.tsx \
        src/store/telemetry-store.ts
git commit -m "feat(ui): add SyncIndicator pill for five-state indexer health"
```

---

## Task 11: Wire `<SyncIndicator />` into the header

**Files:**

- Modify: `src/components/layout/Header.tsx`

- [ ] **Step 1: Update the left cell to stack the indicator above the aggregation toggle**

In `src/components/layout/Header.tsx`, replace lines 34–56 (the left column div):

```tsx
import { SyncIndicator } from "./SyncIndicator";

// ... inside the grid:
{
  /* Left: sync indicator (always) + aggregation toggle (Network + Compute only). */
}
<div className="flex flex-col items-center gap-2 justify-self-center sm:items-start sm:justify-self-start">
  <SyncIndicator />
  {showAggregation && (
    <div className="flex overflow-hidden rounded-lg border border-brand-gray-2">
      {MODES.map(({ value, label }) => {
        const active = aggregationMode === value;
        return (
          <button
            key={value}
            onClick={() => setAggregationMode(value)}
            className="cursor-pointer px-3 py-1.5 font-accent text-sm transition-all"
            style={{
              backgroundColor: active ? "#4CE0FF20" : "transparent",
              color: active ? "#4CE0FF" : "#A9A9A9",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  )}
</div>;
```

- [ ] **Step 2: Manually verify in the dev server**

Run: `bun dev` (or the repo's documented dev command).
Open the dashboard in a browser. Confirm:

- In "My Node" view: SyncIndicator appears alone in the left cell.
- In "Network" or "Compute" view: SyncIndicator stacks above the aggregation toggle.
- Indicator color/text changes with backend state (force synchronizing by restarting the indexer with a bogus `BACKFILL_FROM_EPOCH` if needed; force stalled by stopping the indexer).

- [ ] **Step 3: Run full suite — expect PASS**

Run: `bun test`

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/Header.tsx
git commit -m "feat(ui): place SyncIndicator in header left cell (layout B)"
```

---

## Task 12: Finalize server + UI type renames

**Files:**

- Modify: `src/components/views/Network/RecentBlocksTable.tsx`
- Modify: `src/components/views/Network/RecentBlocksTable.test.tsx`
- Modify: `server/app.test.ts`

Task 1 already renamed every site to tip/backfill fields to keep the code compiling. This task is a final sweep to ensure nothing still reads the old `cursorEpoch` names in any comment, fixture name, or string literal.

- [ ] **Step 1: Grep for leftovers**

Run: `rg -n "cursorEpoch|cursorBlockIndex|indexerLagBlocks" src server api indexer`
Expected: no matches in runtime code. If matches appear in migration/comment text, update or remove them.

- [ ] **Step 2: Run full suite — expect PASS**

Run: `bun test`
Expected: all pass.

- [ ] **Step 3: Type-check**

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add -p
git commit -m "refactor: final sweep of cursor→tip rename in UI and tests"
```

---

## Task 13: End-to-end smoke test

**Files:**

- No code changes; verification only.

- [ ] **Step 1: Start the dashboard against a real node**

Run: the repo's documented local-run command (see `README.md`) with `QUIP_NODE_URL=https://qpu-1.nodes.quip.network` and `QUIP_NODE_TOKEN` set.

- [ ] **Step 2: Verify the tip-first behavior**

Within one poll cycle (~8s), the header indicator should leave "Connecting" and enter either "Synchronizing · N blocks behind" (briefly) or "Backfilling history" (longer, while prior canonical epochs fill in). The EpochSelector should show the node's current `latestEpoch` as `(live)` almost immediately.

- [ ] **Step 3: Verify backfill ordering**

Watch the indexer logs or query the DB: after the first tip poll, `blocks` rows for `latestEpoch` exist. Subsequent `blocks` rows appear for prior canonical epochs (same chain anchor) before any dead-fork epochs.

- [ ] **Step 4: Verify error isolation**

Temporarily block the node's `/blocks/<dead-fork-epoch>/…` endpoint (or point the backfill client at a 429-throttled path). Observe: the tip indicator stays green ("Live") while the backfill indicator color changes to amber ("Backfilling history"). A backfill rate-limit does not cause the tip to stall.

- [ ] **Step 5: Verify stalled detection**

Kill the indexer process. Within 5 minutes the indicator must flip to red ("Indexer offline · Xm") and the RecentBlocksTable banner must surface the same state. Restart the indexer; indicator returns to "Live" (or "Backfilling") after the first successful poll.

- [ ] **Step 6: Final commit (if any tweaks surfaced)**

If verification uncovered a regression, loop back to the relevant task. Otherwise no commit needed — the smoke test is a gate, not a code change.

---

## Self-review notes

**Spec coverage:**

- Motivation (tip-first indexing, UI indicator): Tasks 7, 10, 11.
- Architecture invariants: encoded across Tasks 7–9.
- Data model (`IndexerObservability`, `IndexerState`): Tasks 1, 3.
- Workflows (tip, backfill, startup): Tasks 7, 8, 9.
- UI (SyncIndicator, Header layout B, staleness): Tasks 4, 10, 11.
- Error handling (worker isolation, AuthError, rate-limit): Tasks 7, 8, 9.
- Testing (tip-worker, backfill-worker, staleness, SyncIndicator): Tasks 4, 7, 8, 9, 10.
- Configuration (`BACKFILL_IDLE_RECHECK_SEC`): Task 5.
- Rollout (no schema bump, meta-JSON persistence): Tasks 1, 2, 3.

**Placeholder scan:** No TBDs or generic "add appropriate error handling" stubs; every step has concrete code or exact commands. One intentional note is the spec-vs-implementation mismatch on `state.json` vs `meta[indexer_cursors]` — called out in the plan header so reviewers aren't surprised.

**Type consistency:**

- `IndexerObservability` fields (`tipEpoch`, `tipBlockIndex`, `backfillEpoch`, `backfillBlockIndex`) are used consistently across Tasks 1, 4, 7, 8, 10.
- `SyncStage` values (`connecting`, `synchronizing`, `backfilling`, `caught_up`, `stalled`) match between staleness.ts (Task 4) and SyncIndicator (Task 10).
- `WorkerDeps` (renamed from `LoopDeps`) is defined in `shared.ts` (Task 6) and imported by both workers (Tasks 7, 8).
- `getCursors` / `saveCursors` signatures match between adapter interface (Task 2), both adapter impls (Task 2), and `IndexerState.load/save` (Task 3).
