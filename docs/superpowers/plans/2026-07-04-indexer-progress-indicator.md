# Indexer Progress Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a header line under "Connected Miner" showing the indexer's synchronization progress (validator node sync, then dashboard backfill) as `current / total`, hidden once live.

**Architecture:** A pure helper (`computeIndexerProgress`) derives a two-stage progress value from the already-in-store `IndexerObservability`; a tiny presentational component renders it; `Header.tsx` mounts it inside the Connected Miner block. Frontend-only — no backend, parser, DB, or shared-type changes.

**Tech Stack:** React + TypeScript, Zustand telemetry store, Bun test + happy-dom, Tailwind.

## Global Constraints

- Frontend-only: touch only `apps/frontend/src`. No changes to `@quip/shared`, `@quip/core`, `@quip/server`, or `@quip/indexer`.
- Every new `.ts`/`.tsx` file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Absolute imports via the `@/` alias — no `../` relative paths.
- Number formatting: `value.toLocaleString("en-US")` (matches `SyncIndicator`).
- Indexing metric is approach A: `total = chainHeadFromNode`, `current = chainHeadFromNode − backfillQueueDepth`.
- `LIVE_THRESHOLD = 2` (queue at/below this is routine live tip churn → hidden).
- No debounce; flicker between stages on a flapping validator is acceptable.
- Test command in this environment (podman unavailable, dev stack running): `docker exec deploy-app-1 bash -lc 'cd /app && bun test <path>'`. Canonical equivalent: `./run test <path>`. Typecheck: `docker exec deploy-app-1 bash -lc 'cd /app && bun run typecheck'`.

---

## File Structure

- **Create** `apps/frontend/src/lib/indexer-progress.ts` — pure `computeIndexerProgress` helper, `IndexerProgress` type, `LIVE_THRESHOLD`. No React, no store.
- **Create** `apps/frontend/src/lib/indexer-progress.test.ts` — helper unit tests (exhaustive stage/boundary coverage).
- **Create** `apps/frontend/src/components/layout/IndexerProgress.tsx` — presentational component reading the store, calling the helper.
- **Create** `apps/frontend/src/components/layout/IndexerProgress.test.tsx` — light render test (one stage + hidden).
- **Modify** `apps/frontend/src/components/layout/Header.tsx` — import and render `<IndexerProgress />` under the Connected Miner address.

---

### Task 1: Pure `computeIndexerProgress` helper

**Files:**

- Create: `apps/frontend/src/lib/indexer-progress.ts`
- Test: `apps/frontend/src/lib/indexer-progress.test.ts`

**Interfaces:**

- Consumes: `IndexerObservability` from `@quip/shared/telemetry`; `computeChainHealth` from `@/lib/staleness` (signature: `computeChainHealth({ nowMs: number; tipBlockTimestampMs: number | null; indexer: IndexerObservability | null }): { stage: "connecting" | "caught_up" | "stalled"; ... }`).
- Produces:
  - `export const LIVE_THRESHOLD = 2`
  - `export type IndexerProgress = { stage: "node-sync"; current: number; total: number } | { stage: "indexing"; current: number; total: number }`
  - `export function computeIndexerProgress(indexer: IndexerObservability | null, nowMs: number): IndexerProgress | null`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/indexer-progress.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { IndexerObservability } from "@quip/shared/telemetry";

import { computeIndexerProgress, LIVE_THRESHOLD } from "./indexer-progress";

const NOW = Date.parse("2026-07-04T00:00:00.000Z");

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = new Date(NOW).toISOString();
  return {
    chainHeadFromNode: "559745",
    lastStatusFetchAt: now,
    lastBlockInsertAt: now,
    lastSubstrateEventAt: now,
    bestBlockHeight: "559745",
    finalizedBlockHeight: "559745",
    chainConnected: true,
    minerStats: null,
    ...overrides,
  };
}

const progress = (depth: number): NonNullable<IndexerObservability["indexer"]> => ({
  backfillQueueDepth: depth,
  coverage: {},
  difficultyDataStartBlock: null,
});

describe("computeIndexerProgress", () => {
  it("returns null when observability is absent", () => {
    expect(computeIndexerProgress(null, NOW)).toBeNull();
  });

  it("returns null when the indexer heartbeat is stale", () => {
    const stale = obs({ lastStatusFetchAt: new Date(NOW - 10 * 60_000).toISOString() });
    expect(computeIndexerProgress(stale, NOW)).toBeNull();
  });

  it("reports node-sync while the validator is syncing behind the tip", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: "559624",
      nodeSyncHighestBlock: "559745",
    });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "node-sync",
      current: 559624,
      total: 559745,
    });
  });

  it("does not report node-sync once current has reached highest", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: "559745",
      nodeSyncHighestBlock: "559745",
      indexer: progress(0),
    });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("reports indexing progress from chainHead minus backfill depth", () => {
    const o = obs({ chainHeadFromNode: "559745", indexer: progress(4145) });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 555_600,
      total: 559_745,
    });
  });

  it("treats a queue at or below LIVE_THRESHOLD as live (null)", () => {
    const o = obs({ indexer: progress(LIVE_THRESHOLD) });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("falls through to indexing when nodeSyncing lacks progress numbers", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: null,
      nodeSyncHighestBlock: null,
      indexer: progress(100),
    });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 559_645,
      total: 559_745,
    });
  });

  it("returns null in the indexing branch when chainHead is unknown", () => {
    const o = obs({ chainHeadFromNode: null, indexer: progress(100) });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("clamps current to 0 when depth exceeds chainHead", () => {
    const o = obs({ chainHeadFromNode: "50", indexer: progress(100) });
    expect(computeIndexerProgress(o, NOW)).toEqual({ stage: "indexing", current: 0, total: 50 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/frontend/src/lib/indexer-progress.test.ts'`
Expected: FAIL — cannot resolve `./indexer-progress` / `computeIndexerProgress is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/frontend/src/lib/indexer-progress.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { computeChainHealth } from "@/lib/staleness";
import type { IndexerObservability } from "@quip/shared/telemetry";

// backfillQueueDepth ticks to ~1 on each new live block (the tip bucket), so a
// strict `> 0` test would keep the indicator visible during normal operation
// and never reach the hidden "live" state. Treat a queue at/below this as
// routine live churn, not catch-up.
export const LIVE_THRESHOLD = 2;

export type IndexerProgress =
  | { stage: "node-sync"; current: number; total: number }
  | { stage: "indexing"; current: number; total: number };

// Block heights are u64-as-string; on this chain they are far below
// Number.MAX_SAFE_INTEGER, so Number() is safe for display math.
function toBlockNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Two-stage indexer progress for the header line under Connected Miner.
 *
 * 1. node-sync — the connected validator is still importing blocks
 *    (nodeSyncing, current < highest).
 * 2. indexing — the dashboard's own backfill is catching up
 *    (backfillQueueDepth above LIVE_THRESHOLD).
 *
 * Returns null when there is nothing to show: no observability, a wedged/stale
 * indexer (the SyncIndicator owns that "offline" messaging), or fully live.
 */
export function computeIndexerProgress(
  indexer: IndexerObservability | null,
  nowMs: number,
): IndexerProgress | null {
  if (indexer === null) return null;

  // A wedged indexer can leave fresh-looking numbers in the cached response;
  // reuse the exact heartbeat-stale rule (only that check yields "stalled").
  if (computeChainHealth({ nowMs, tipBlockTimestampMs: null, indexer }).stage === "stalled") {
    return null;
  }

  // Stage 1: validator node sync.
  if (indexer.nodeSyncing === true) {
    const current = toBlockNum(indexer.nodeSyncCurrentBlock);
    const total = toBlockNum(indexer.nodeSyncHighestBlock);
    if (current !== null && total !== null && current < total) {
      return { stage: "node-sync", current, total };
    }
  }

  // Stage 2: dashboard indexer backfill (approach A: remaining-based).
  const depth = indexer.indexer?.backfillQueueDepth;
  const total = toBlockNum(indexer.chainHeadFromNode);
  if (typeof depth === "number" && depth > LIVE_THRESHOLD && total !== null) {
    const current = Math.min(total, Math.max(0, total - depth));
    return { stage: "indexing", current, total };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/frontend/src/lib/indexer-progress.test.ts'`
Expected: PASS — 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/indexer-progress.ts apps/frontend/src/lib/indexer-progress.test.ts
git commit -m "feat(frontend): add computeIndexerProgress helper"
```

---

### Task 2: `IndexerProgress` component

**Files:**

- Create: `apps/frontend/src/components/layout/IndexerProgress.tsx`
- Test: `apps/frontend/src/components/layout/IndexerProgress.test.tsx`

**Interfaces:**

- Consumes: `computeIndexerProgress`, `IndexerProgress` from `@/lib/indexer-progress`; `useTelemetryStore` and `selectServerNowMs` from `@/store/telemetry-store` (`selectServerNowMs(state): number`, server-anchored now, falls back to `Date.now()` when `serverTime` is null).
- Produces: `export function IndexerProgress(): JSX.Element | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/layout/IndexerProgress.test.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { IndexerObservability } from "@quip/shared/telemetry";

import { IndexerProgress } from "./IndexerProgress";

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = new Date().toISOString();
  return {
    chainHeadFromNode: "559745",
    lastStatusFetchAt: now,
    lastBlockInsertAt: now,
    lastSubstrateEventAt: now,
    bestBlockHeight: "559745",
    finalizedBlockHeight: "559745",
    chainConnected: true,
    minerStats: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ indexer: null, serverTime: null });
});

describe("IndexerProgress", () => {
  test("renders indexing progress as current / total", () => {
    useTelemetryStore.setState({
      indexer: obs({
        indexer: { backfillQueueDepth: 4145, coverage: {}, difficultyDataStartBlock: null },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Indexing · 555,600 / 559,745");
  });

  test("renders nothing when live", () => {
    useTelemetryStore.setState({
      indexer: obs({
        indexer: { backfillQueueDepth: 0, coverage: {}, difficultyDataStartBlock: null },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/frontend/src/components/layout/IndexerProgress.test.tsx'`
Expected: FAIL — cannot resolve `./IndexerProgress`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/frontend/src/components/layout/IndexerProgress.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { computeIndexerProgress } from "@/lib/indexer-progress";
import { selectServerNowMs, useTelemetryStore } from "@/store/telemetry-store";

const STAGE_LABEL = {
  "node-sync": "Node sync",
  indexing: "Indexing",
} as const;

// Progress line under "Connected Miner": validator node sync, then dashboard
// backfill, then nothing once live. All state lives in the pure helper; this
// component only reads the store and formats.
export function IndexerProgress() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const nowMs = useTelemetryStore(selectServerNowMs);
  const progress = useMemo(() => computeIndexerProgress(indexer, nowMs), [indexer, nowMs]);
  if (!progress) return null;
  const fmt = (v: number) => v.toLocaleString("en-US");
  return (
    <p className="font-accent text-[10px] text-ink-subtle" role="status" aria-live="polite">
      {STAGE_LABEL[progress.stage]} · {fmt(progress.current)} / {fmt(progress.total)}
    </p>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/frontend/src/components/layout/IndexerProgress.test.tsx'`
Expected: PASS — 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/layout/IndexerProgress.tsx apps/frontend/src/components/layout/IndexerProgress.test.tsx
git commit -m "feat(frontend): add IndexerProgress component"
```

---

### Task 3: Wire into the header

**Files:**

- Modify: `apps/frontend/src/components/layout/Header.tsx`

**Interfaces:**

- Consumes: `IndexerProgress` from `./IndexerProgress`.
- Produces: nothing new; renders the line under the Connected Miner address.

- [ ] **Step 1: Add the import**

In `apps/frontend/src/components/layout/Header.tsx`, alongside the sibling layout imports (near `import { SyncIndicator } from "./SyncIndicator";`), add:

```tsx
import { IndexerProgress } from "./IndexerProgress";
```

- [ ] **Step 2: Render it under the Connected Miner address**

In the Connected Miner block, immediately after the address paragraph:

```tsx
            <p className="font-mono text-xs text-ink-strong">{shortAddress(selfAddress)}</p>
            <IndexerProgress />
```

(The `<IndexerProgress />` line is the only addition; the component returns null on its own when there's nothing to show, so no extra conditional is needed.)

- [ ] **Step 3: Typecheck + full frontend test run**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun run typecheck'`
Expected: all five workspaces exit 0.

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/frontend/src/lib/indexer-progress.test.ts apps/frontend/src/components/layout/IndexerProgress.test.tsx'`
Expected: 11 pass, 0 fail.

- [ ] **Step 4: Drive the running app to see it**

The dev stack is running (Vite on http://localhost:5173, indexer pointed at the local node's front door). Backfill of a fresh/behind indexer shows the "Indexing · current / total" line under Connected Miner; a caught-up indexer shows nothing. Verify by loading `http://localhost:5173/` and reading the Connected Miner block in the header. (If already fully caught up, temporarily confirm via the component test's rendered text, which exercises the same path.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/layout/Header.tsx
git commit -m "feat(frontend): show indexer progress under Connected Miner"
```

---

## Self-Review

**Spec coverage:**

- Placement under Connected Miner → Task 3. ✓
- Three states (node-sync / indexing / live-hidden) → Task 1 helper + tests. ✓
- Absent/stale guard reusing `lib/staleness` → Task 1 (`computeChainHealth(... ).stage === "stalled"`). ✓
- Indexing metric approach A + `LIVE_THRESHOLD` → Task 1. ✓
- Node-sync metric from `nodeSync*` → Task 1. ✓
- `toLocaleString` formatting, `role="status"`/`aria-live` → Task 2. ✓
- Pure helper + component + Header files → Tasks 1-3 match spec "Files". ✓
- Testing list (all enumerated cases) → Task 1 test has all nine; boundary/clamp/missing-field covered. ✓
- Non-goals (no bar/%, no debounce, no backend) → respected. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `IndexerProgress` shape identical in helper, component, and tests; `computeIndexerProgress(indexer, nowMs)` argument order consistent across all call sites; `progress()` test fixture matches `IndexerObservability["indexer"]` (backfillQueueDepth/coverage/difficultyDataStartBlock).
