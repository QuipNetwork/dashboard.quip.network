# Server-Computed Backfill ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have the indexer compute and publish `backfillEtaSeconds`, and have the frontend display it directly (removing the client-side ETA sampling), so the backfill ETA appears instantly and survives page refreshes.

**Architecture:** The reconciler's `publishProgress()` accumulates `(now, totalGaps)` samples and computes an ETA from the net decline over a rolling window; it publishes `backfillEtaSeconds` in the backfill-progress observability. The value flows through the parser whitelist and server to the frontend, which just formats it. The frontend's own sampling logic is deleted.

**Tech Stack:** TypeScript, Bun test, Kysely/pglite (core), RxJS (indexer), React/Zustand (frontend).

## Global Constraints

- Dependency direction: `shared ← core ← {indexer}`, and `frontend ← shared` only. Never import across these boundaries otherwise.
- Every new `.ts`/`.tsx` file starts with the exact first line: `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Absolute imports only; frontend uses the `@/` alias; no `../` relative paths outside a package's own dir (sibling `./name` within a dir is the established convention).
- No `Date.now()` in the indexer — use the injected `deps.now()` clock.
- Number formatting on the frontend uses `value.toLocaleString("en-US")`.
- Window/threshold constants: `ETA_WINDOW_MS = 120_000`, `ETA_MIN_SPAN_MS = 90_000`.
- `backfillEtaSeconds` is an OPTIONAL field (`?: number | null`) so pre-field persisted rows and existing fixtures parse/typecheck cleanly.
- Test command (podman unavailable; dev container `deploy-app-1`, repo at `/app`): `docker exec deploy-app-1 bash -lc 'cd /app && bun test <path>'`. Typecheck: `docker exec deploy-app-1 bash -lc 'cd /app && bun run typecheck'`.

---

## File Structure

- **Create** `apps/indexer/pipeline/backfill-eta.ts` — pure ETA helper (`pushEtaSample`, `estimateEtaSeconds`, `EtaSample`).
- **Create** `apps/indexer/pipeline/backfill-eta.test.ts` — unit tests for the helper.
- **Modify** `packages/shared/telemetry/response.ts` — add `backfillEtaSeconds?: number | null` to `IndexerBackfillProgress`.
- **Modify** `packages/core/api/db/adapter.ts` — `parseIndexerProgress` carries the field.
- **Modify** `packages/core/api/db/kysely-adapter.test.ts` — round-trip test for the field.
- **Modify** `apps/indexer/pipeline/producers.ts` — `Reconciler` accumulates samples in `publishProgress` and publishes the ETA.
- **Modify** `apps/indexer/pipeline/producers.test.ts` — assert the field is wired.
- **Modify** `apps/frontend/src/lib/indexer-eta.ts` — delete the sampling API; keep `formatEta`.
- **Modify** `apps/frontend/src/lib/indexer-eta.test.ts` — keep only `formatEta` tests.
- **Modify** `apps/frontend/src/components/layout/IndexerProgress.tsx` — read `backfillEtaSeconds`; remove sampling.
- **Modify** `apps/frontend/src/components/layout/IndexerProgress.test.tsx` — feed the field; drop accumulation tests.

---

### Task 1: Indexer pure ETA helper

**Files:**
- Create: `apps/indexer/pipeline/backfill-eta.ts`
- Test: `apps/indexer/pipeline/backfill-eta.test.ts`

**Interfaces:**
- Produces (later tasks depend on these):
  - `export interface EtaSample { atMs: number; remaining: number }`
  - `export const ETA_WINDOW_MS = 120_000`, `export const ETA_MIN_SPAN_MS = 90_000`
  - `export function pushEtaSample(samples: EtaSample[], next: EtaSample, windowMs?: number): EtaSample[]`
  - `export function estimateEtaSeconds(samples: EtaSample[], minSpanMs?: number): number | null`

- [ ] **Step 1: Write the failing test** — create `apps/indexer/pipeline/backfill-eta.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { estimateEtaSeconds, pushEtaSample, type EtaSample } from "./backfill-eta";

describe("pushEtaSample", () => {
  it("appends the first sample", () => {
    expect(pushEtaSample([], { atMs: 1000, remaining: 500 })).toEqual([
      { atMs: 1000, remaining: 500 },
    ]);
  });

  it("ignores a sample whose timestamp did not advance", () => {
    const s: EtaSample[] = [{ atMs: 1000, remaining: 500 }];
    expect(pushEtaSample(s, { atMs: 1000, remaining: 400 })).toBe(s);
    expect(pushEtaSample(s, { atMs: 900, remaining: 400 })).toBe(s);
  });

  it("trims samples older than the trailing window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 900 },
      { atMs: 50_000, remaining: 800 },
    ];
    expect(pushEtaSample(s, { atMs: 130_000, remaining: 700 }, 120_000)).toEqual([
      { atMs: 50_000, remaining: 800 },
      { atMs: 130_000, remaining: 700 },
    ]);
  });
});

describe("estimateEtaSeconds", () => {
  it("returns null with fewer than two samples", () => {
    expect(estimateEtaSeconds([{ atMs: 0, remaining: 100 }], 90_000)).toBeNull();
  });

  it("returns null until the window reaches the minimum span", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 12_000 },
      { atMs: 60_000, remaining: 8_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBeNull();
  });

  it("estimates seconds-to-done from the net decline over the window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 12_000 },
      { atMs: 120_000, remaining: 8_000 },
    ];
    // closed 4000 over 120000ms; 8000 / (4000/120000) = 240000ms = 240s.
    expect(estimateEtaSeconds(s, 90_000)).toBe(240);
  });

  it("returns null when the deficit grew over the window", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 8_000 },
      { atMs: 120_000, remaining: 9_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBeNull();
  });

  it("returns null when the deficit is flat", () => {
    const s: EtaSample[] = [
      { atMs: 0, remaining: 8_000 },
      { atMs: 120_000, remaining: 8_000 },
    ];
    expect(estimateEtaSeconds(s, 90_000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/indexer/pipeline/backfill-eta.test.ts'`
Expected: FAIL — cannot resolve `./backfill-eta`.

- [ ] **Step 3: Write minimal implementation** — create `apps/indexer/pipeline/backfill-eta.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rolling estimate of "seconds until the backfill catches up", derived from
// successive readings of the remaining deficit (summed coverage gapBlocks). The
// deficit jitters as the coverage walker discovers new gaps, so the rate is the
// NET decline across a trailing window, and no estimate is offered until the
// window has enough history or when the deficit is not net-shrinking.

export interface EtaSample {
  atMs: number;
  remaining: number;
}

export const ETA_WINDOW_MS = 120_000;
export const ETA_MIN_SPAN_MS = 90_000;
const MAX_SAMPLES = 240;

/** Append `next` and drop anything older than `windowMs`. Ignores a sample
 * whose timestamp did not advance, returning the same array reference. */
export function pushEtaSample(
  samples: EtaSample[],
  next: EtaSample,
  windowMs: number = ETA_WINDOW_MS,
): EtaSample[] {
  const last = samples[samples.length - 1];
  if (last && next.atMs <= last.atMs) return samples;
  const cutoff = next.atMs - windowMs;
  const trimmed = samples.filter((s) => s.atMs >= cutoff);
  trimmed.push(next);
  return trimmed.length > MAX_SAMPLES ? trimmed.slice(trimmed.length - MAX_SAMPLES) : trimmed;
}

/** Seconds until the deficit reaches zero at the window's net rate, or null when
 * there isn't `minSpanMs` of history yet or the deficit isn't shrinking. */
export function estimateEtaSeconds(
  samples: EtaSample[],
  minSpanMs: number = ETA_MIN_SPAN_MS,
): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const spanMs = last.atMs - first.atMs;
  if (spanMs < minSpanMs) return null;
  const closed = first.remaining - last.remaining;
  if (closed <= 0) return null;
  const ratePerMs = closed / spanMs;
  return Math.round(last.remaining / ratePerMs / 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/indexer/pipeline/backfill-eta.test.ts'`
Expected: PASS — 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/indexer/pipeline/backfill-eta.ts apps/indexer/pipeline/backfill-eta.test.ts
git commit -m "feat(indexer): add pure backfill-eta helper"
```

---

### Task 2: Shared type + parser + round-trip test

**Files:**
- Modify: `packages/shared/telemetry/response.ts` (inside `interface IndexerBackfillProgress`, after `difficultyDataStartBlock`)
- Modify: `packages/core/api/db/adapter.ts:112-116` (the `parseIndexerProgress` return object)
- Test: `packages/core/api/db/kysely-adapter.test.ts` (add a test in the same `describe` as `roundtrips self address and observability`, near line 306)

**Interfaces:**
- Consumes: nothing.
- Produces: `IndexerBackfillProgress` now has an optional `backfillEtaSeconds?: number | null`, and `parseIndexerProgress` always sets it (number or null).

- [ ] **Step 1: Write the failing test** — in `packages/core/api/db/kysely-adapter.test.ts`, add this test immediately after the existing `it("roundtrips self address and observability", …)` test (after its closing `});`, ~line 306):

```ts
      it("roundtrips backfillEtaSeconds through the indexer progress whitelist", async () => {
        const obs = {
          chainHeadFromNode: "300",
          lastStatusFetchAt: "2026-01-01T00:00:00.000Z",
          lastBlockInsertAt: null,
          lastSubstrateEventAt: null,
          bestBlockHeight: "300",
          finalizedBlockHeight: "300",
          chainConnected: true,
          indexer: {
            backfillQueueDepth: 5,
            coverage: {},
            difficultyDataStartBlock: null,
            backfillEtaSeconds: 780,
          },
        } as IndexerObservability;
        await db.setIndexerObservability(obs);
        const got = await db.getIndexerObservability();
        expect(got?.indexer?.backfillEtaSeconds).toBe(780);
      });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test packages/core/api/db/kysely-adapter.test.ts'`
Expected: FAIL — `got.indexer.backfillEtaSeconds` is `undefined` (stripped by the whitelist), so `toBe(780)` fails.

- [ ] **Step 3a: Add the field to the shared type** — in `packages/shared/telemetry/response.ts`, inside `interface IndexerBackfillProgress`, immediately after the `difficultyDataStartBlock: string | null;` line, add:

```ts
  // Server-computed seconds until the backfill catches up, or null when there
  // isn't enough history yet or the deficit isn't net-shrinking. Optional so
  // pre-field persisted rows / a just-restarted indexer parse cleanly.
  backfillEtaSeconds?: number | null;
```

- [ ] **Step 3b: Carry it in the parser** — in `packages/core/api/db/adapter.ts`, change the `parseIndexerProgress` return object (lines 112-116) from:

```ts
  return {
    backfillQueueDepth: p.backfillQueueDepth,
    coverage,
    difficultyDataStartBlock: (p.difficultyDataStartBlock ?? null) as string | null,
  };
```

to:

```ts
  return {
    backfillQueueDepth: p.backfillQueueDepth,
    coverage,
    difficultyDataStartBlock: (p.difficultyDataStartBlock ?? null) as string | null,
    backfillEtaSeconds: typeof p.backfillEtaSeconds === "number" ? p.backfillEtaSeconds : null,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test packages/core/api/db/kysely-adapter.test.ts'`
Expected: PASS (including the new round-trip test).

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun run typecheck'`
Expected: all workspaces exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/telemetry/response.ts packages/core/api/db/adapter.ts packages/core/api/db/kysely-adapter.test.ts
git commit -m "feat(core): carry backfillEtaSeconds through observability parser"
```

---

### Task 3: Reconciler publishes the ETA

**Files:**
- Modify: `apps/indexer/pipeline/producers.ts` (the `Reconciler` class @ line 333; `publishProgress()` @ lines 533-561)
- Test: `apps/indexer/pipeline/producers.test.ts` (extend the `Reconciler sync gating` harness's `makeDeps`, ~lines 200-229)

**Interfaces:**
- Consumes: `pushEtaSample`, `estimateEtaSeconds`, `EtaSample` from `./backfill-eta` (Task 1); `backfillEtaSeconds?` on `IndexerBackfillProgress` (Task 2).
- Produces: `state.observability.indexer.backfillEtaSeconds` set on every `publishProgress`.

- [ ] **Step 1: Write the failing test** — in `apps/indexer/pipeline/producers.test.ts`:

First, add the import at the top (alongside the existing producer imports):

```ts
import type { IndexerState } from "../core/state";
```

Then, inside the `describe("Reconciler sync gating", …)` block, add this test after the existing tests (before the block's closing `});`). It sets a real `state`, drives one ungated tick with an empty registry (so `totalGaps` is 0 and the ETA is null), and asserts the field is present and wired:

```ts
  test("publishProgress sets backfillEtaSeconds on the observability", async () => {
    const state = {
      observability: { indexer: undefined },
    } as unknown as IndexerState;
    const { deps } = makeDeps({});
    const reconciler = new Reconciler({ ...deps, state });
    await reconciler.tick();
    expect(state.observability.indexer).toBeDefined();
    // Empty registry → 0 gaps → never net-shrinking → null, but the key is set.
    expect(state.observability.indexer!.backfillEtaSeconds).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/indexer/pipeline/producers.test.ts'`
Expected: FAIL — `backfillEtaSeconds` is `undefined` on the published object (property not set yet).

- [ ] **Step 3a: Import the helper** — at the top of `apps/indexer/pipeline/producers.ts`, add:

```ts
import { estimateEtaSeconds, pushEtaSample, type EtaSample } from "./backfill-eta";
```

- [ ] **Step 3b: Add the sample buffer field** — in the `Reconciler` class body (near its other private fields, e.g. after `readonly done$ = new Subject<void>();`), add:

```ts
  // Rolling (now, totalGaps) samples feeding the published backfill ETA.
  private etaSamples: EtaSample[] = [];
```

- [ ] **Step 3c: Accumulate and publish** — in `publishProgress()` (`producers.ts`), replace the `deps.state.observability.indexer = { … }` assignment (lines 555-561) with:

```ts
    const totalGaps = Object.values(coverage).reduce((sum, c) => sum + c.gapBlocks, 0);
    this.etaSamples = pushEtaSample(this.etaSamples, {
      atMs: deps.now(),
      remaining: totalGaps,
    });
    deps.state.observability.indexer = {
      backfillQueueDepth: deps.queue.totalDepth(),
      coverage,
      difficultyDataStartBlock: difficulty
        ? String(deps.store.coverageFor("difficulty").start)
        : null,
      backfillEtaSeconds: estimateEtaSeconds(this.etaSamples),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/indexer/pipeline/producers.test.ts'`
Expected: PASS.

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun run typecheck'`
Expected: all workspaces exit 0.

Note: the ETA *dynamics* (null before 90s of history, positive once the deficit net-shrinks, null when it grows) are exhaustively covered by Task 1's `estimateEtaSeconds` unit tests; this task verifies only that `publishProgress` accumulates `totalGaps` and wires the field.

- [ ] **Step 5: Commit**

```bash
git add apps/indexer/pipeline/producers.ts apps/indexer/pipeline/producers.test.ts
git commit -m "feat(indexer): publish backfillEtaSeconds from the reconciler"
```

---

### Task 4: Frontend consumes the published ETA

**Files:**
- Modify: `apps/frontend/src/lib/indexer-eta.ts` (delete sampling API; keep `formatEta`)
- Modify: `apps/frontend/src/lib/indexer-eta.test.ts` (keep only `formatEta` tests)
- Modify: `apps/frontend/src/components/layout/IndexerProgress.tsx`
- Modify: `apps/frontend/src/components/layout/IndexerProgress.test.tsx`

**Interfaces:**
- Consumes: `backfillEtaSeconds?` on `IndexerObservability["indexer"]` (Task 2); `formatEta` (kept).
- Produces: nothing new.

- [ ] **Step 1: Replace `indexer-eta.ts` with just the formatter** — overwrite `apps/frontend/src/lib/indexer-eta.ts` with:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Compact human ETA from milliseconds: "<1m", "~4m", "~1h", "~1h 30m". */
export function formatEta(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}
```

- [ ] **Step 2: Trim `indexer-eta.test.ts` to the formatter** — overwrite `apps/frontend/src/lib/indexer-eta.test.ts` with:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { formatEta } from "./indexer-eta";

describe("formatEta", () => {
  it("renders sub-minute as <1m", () => {
    expect(formatEta(20_000)).toBe("<1m");
  });

  it("renders minutes", () => {
    expect(formatEta(240_000)).toBe("~4m");
  });

  it("renders whole hours", () => {
    expect(formatEta(3_600_000)).toBe("~1h");
  });

  it("renders hours and minutes", () => {
    expect(formatEta(5_400_000)).toBe("~1h 30m");
  });
});
```

- [ ] **Step 3: Simplify the component** — overwrite `apps/frontend/src/components/layout/IndexerProgress.tsx` with:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { formatEta } from "@/lib/indexer-eta";
import { computeIndexerProgress } from "@/lib/indexer-progress";
import { selectServerNowMs, useTelemetryStore } from "@/store/telemetry-store";

const STAGE_LABEL = {
  "node-sync": "Node sync",
  indexing: "Indexing",
} as const;

// Progress line under "Connected Miner": validator node sync, then dashboard
// backfill (with a server-computed ETA), then nothing once live.
export function IndexerProgress() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const nowMs = useTelemetryStore(selectServerNowMs);
  const progress = useMemo(() => computeIndexerProgress(indexer, nowMs), [indexer, nowMs]);
  if (!progress) return null;
  const fmt = (v: number) => v.toLocaleString("en-US");
  const etaSec = progress.stage === "indexing" ? indexer?.indexer?.backfillEtaSeconds : null;
  const eta = typeof etaSec === "number" && etaSec > 0 ? ` · ${formatEta(etaSec * 1000)}` : "";
  return (
    <p
      className="font-accent text-[10px] text-ink-subtle"
      role="status"
      aria-live="polite"
    >
      {STAGE_LABEL[progress.stage]} · {fmt(progress.current)} / {fmt(progress.total)}
      {eta}
    </p>
  );
}
```

- [ ] **Step 4: Update the component test** — in `apps/frontend/src/components/layout/IndexerProgress.test.tsx`, (a) DELETE the two tests titled `"omits the ETA suffix until enough history exists"` and `"appends a smoothed ETA once the deficit shrinks over the window"`, and (b) add these two tests inside the `describe("IndexerProgress", …)` block (the `cov` helper and `obs` factory already exist in the file):

```ts
  test("appends the server ETA when backfillEtaSeconds is set", () => {
    useTelemetryStore.setState({
      indexer: obs({
        chainHeadFromNode: "560000",
        indexer: { ...cov(12_000), backfillEtaSeconds: 780 },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Indexing · 548,000 / 560,000 · ~13m");
  });

  test("omits the ETA when backfillEtaSeconds is null", () => {
    useTelemetryStore.setState({
      indexer: obs({
        chainHeadFromNode: "560000",
        indexer: { ...cov(12_000), backfillEtaSeconds: null },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Indexing · 548,000 / 560,000");
    expect(container.textContent).not.toMatch(/~\d/);
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun test apps/frontend/src/lib/indexer-eta.test.ts apps/frontend/src/lib/indexer-progress.test.ts apps/frontend/src/components/layout/IndexerProgress.test.tsx'`
Expected: all pass, 0 fail.

Run: `docker exec deploy-app-1 bash -lc 'cd /app && bun run typecheck'`
Expected: all workspaces exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/lib/indexer-eta.ts apps/frontend/src/lib/indexer-eta.test.ts apps/frontend/src/components/layout/IndexerProgress.tsx apps/frontend/src/components/layout/IndexerProgress.test.tsx
git commit -m "feat(frontend): show server-computed backfill ETA, drop client sampling"
```

---

## Self-Review

**Spec coverage:**
- Pure server ETA helper → Task 1. ✓
- Wiring in `publishProgress` with `deps.now`, summed gapBlocks → Task 3. ✓
- Shared type field → Task 2. ✓
- Parser carries it + round-trip test → Task 2. ✓
- Frontend removes sampling, formats seconds → Task 4. ✓
- `formatEta` kept → Task 4. ✓
- Testing (helper units, producer wiring, parser round-trip, component) → Tasks 1-4. ✓
- Non-goals (no persistence, no rate field, metric/stage unchanged) → respected. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `EtaSample`/`pushEtaSample`/`estimateEtaSeconds` identical across Task 1 (def), Task 3 (use). `backfillEtaSeconds?: number | null` identical across Task 2 (type), Task 3 (set), Task 4 (read). `formatEta(ms)` takes ms; frontend passes `etaSec * 1000`. Component test's `~13m` = `formatEta(780 * 1000)` = `~13m` (780s = 13min). Consistent.
