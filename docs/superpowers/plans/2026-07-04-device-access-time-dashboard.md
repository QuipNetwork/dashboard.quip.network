# Dashboard: winner-reported `device_access_time_us` as block mining time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a winning qblock carries the spec-111 `device_access_time_us` (miner-reported compute time: QPU access time for QPU wins, wall clock for CPU/GPU), the indexer stores it (µs→seconds) as the block's `mining_time`; blocks without it (pre-111, or unreported=0) keep the derived block-spacing wall clock.

**Architecture:** polkadot-js decodes the `quantumPowApi.winningSolution` runtime API from the chain's own metadata, so the new trailing `QBlock` field arrives automatically once runtime 111 activates — no manual SCALE work. The change is three thin layers: (1) extract the field into `QBlockInfo` via a new exported pure mapper (mirroring the `decodeBlockWinnerEventData` testability precedent), (2) prefer it over the derived `blocks × slot-seconds` value in the winners plugin, (3) update the comments/docs that define `mining_time`'s semantics. Wall clock stays recomputable from chain data (`LastProofBlock` spacing), so nothing is lost.

**Tech Stack:** TypeScript, polkadot-js API, bun test.

## Global Constraints

- Repo: `/Users/carback1/Code/quip/dashboard.quip.network`, branch off `v0.2` named `feat/qblock-device-access-time` (third repo of the program: quip-protocol-rs MR !53 MERGED, quip-protocol MR !143 open). Remote is GitLab `origin`.
- `QBlockInfo.deviceAccessTimeUs: number | null` — `null` = field absent (pre-111 chain); `0` = present but unreported. BOTH must fall back to the derived block-spacing value in the winners plugin (`qblock?.deviceAccessTimeUs ? … : derived` — truthiness handles both).
- Conversion: `deviceAccessTimeUs / 1_000_000` (float division — `blocks.mining_time` is DOUBLE PRECISION seconds; do NOT floor).
- polkadot-js `toJSON()` camelCases struct fields; the existing extraction defensively reads both spellings (`sol.energyMilli ?? sol.energy_milli`) — keep that style for the new field.
- Tests: `bun test <file>` per touched file (the repo's `test` script is bun). Existing test expectations that assert the derived 60s value must keep passing via the `null` default in fixtures.
- Commit messages: imperative mood, ≤72-char subject, NO Co-Authored-By or LLM attribution trailers.

## Non-Goals

- No frontend/chart code changes. The Mining-Time chart reads `blocks.mining_time` through `MiningHistoryRow` untouched; its Y-values just get truer. (UI copy like "Time to qblock" is acceptable for both semantics; revisit only if operators find it confusing.)
- No backfill of historical rows (pre-111 blocks have no reported value to backfill).
- No `mining_submissions`-based fallback for self wins (the on-chain value supersedes that idea).

---

### Task 1: Extract `deviceAccessTimeUs` into `QBlockInfo` via a testable mapper

**Files:**
- Modify: `apps/indexer/clients/substrate-client/types.ts` (`QBlockInfo`, ~line 141)
- Modify: `apps/indexer/clients/substrate-client/index.ts` (`getQBlock`, ~lines 454-492)
- Test: `apps/indexer/clients/substrate-client/client.test.ts` (beside the `decodeBlockWinnerEventData` tests)

**Interfaces:**
- Consumes: the raw `sol` record `getQBlock` already builds (`toJSON()`-coerced solution struct).
- Produces: `QBlockInfo.deviceAccessTimeUs: number | null`; exported pure function `qblockInfoFromSolution(sol: Record<string, unknown>, nonce: string): QBlockInfo` — Task 2's fixtures set the field directly on `QBlockInfo`.

- [ ] **Step 1: Write the failing tests**

In `apps/indexer/clients/substrate-client/client.test.ts`, add a describe block beside the BlockWinner decode tests:

```typescript
describe("qblockInfoFromSolution (spec-111 device_access_time_us)", () => {
  const base = {
    miner: "5GWinner",
    energyMilli: -14_500_123,
    reward: "1000000000000",
    submittedAt: "500000",
    difficulty: { maxEnergyMilli: -14_400_000, minDiversityMilli: 100, minSolutions: 2 },
  };

  it("reads the camelCase field polkadot-js toJSON emits", () => {
    const info = qblockInfoFromSolution({ ...base, deviceAccessTimeUs: 45_000_000 }, "123");
    expect(info.deviceAccessTimeUs).toBe(45_000_000);
    expect(info.nonce).toBe("123");
  });

  it("reads the snake_case spelling defensively", () => {
    const info = qblockInfoFromSolution({ ...base, device_access_time_us: 7 }, "123");
    expect(info.deviceAccessTimeUs).toBe(7);
  });

  it("absent field (pre-111 chain) maps to null, not 0", () => {
    const info = qblockInfoFromSolution(base, "123");
    expect(info.deviceAccessTimeUs).toBeNull();
  });

  it("non-numeric garbage maps to null", () => {
    const info = qblockInfoFromSolution({ ...base, deviceAccessTimeUs: "bogus" }, "123");
    expect(info.deviceAccessTimeUs).toBeNull();
  });
});
```

Import `qblockInfoFromSolution` alongside the existing decode import. Match the file's existing fixture/helper style (read the surrounding tests first).

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/indexer/clients/substrate-client/client.test.ts`
Expected: FAIL — `qblockInfoFromSolution` is not exported.

- [ ] **Step 3: Add the field to `QBlockInfo`**

In `apps/indexer/clients/substrate-client/types.ts` (~line 149), after `difficulty`:

```typescript
  // Spec-111 trailing QBlock field: miner-reported compute time for the
  // winning proof, in microseconds — D-Wave QPU access time for QPU wins,
  // wall clock for CPU/GPU. Self-reported (consensus never reads it).
  // `null` when the chain pre-dates runtime 111 (field absent from the
  // runtime API); `0` when present but unreported. Consumers must treat
  // both as "no report" and fall back to derived block spacing.
  deviceAccessTimeUs: number | null;
```

- [ ] **Step 4: Extract the mapper and wire it into `getQBlock`**

In `apps/indexer/clients/substrate-client/index.ts`, move the `return { miner: …, difficulty: … }` mapping at the end of `getQBlock` into an exported pure function placed near `decodeBlockWinnerEventData` (same testability rationale — copy that function's doc-comment style):

```typescript
/**
 * Map a `toJSON()`-coerced `WinningSolution`/`QBlock` struct + its derived
 * nonce into a {@link QBlockInfo}. Exported so the field mapping (including
 * the spec-111 `device_access_time_us` tail) can be unit-tested without a
 * live chain.
 */
export function qblockInfoFromSolution(
  sol: Record<string, unknown>,
  nonce: string,
): QBlockInfo {
  const rawDevice = sol.deviceAccessTimeUs ?? sol.device_access_time_us;
  const device = Number(rawDevice);
  return {
    miner: String(sol.miner),
    energyMilli: Number(sol.energyMilli ?? sol.energy_milli ?? 0),
    reward: String(sol.reward),
    submittedAt: String(sol.submittedAt ?? sol.submitted_at ?? "0"),
    nonce,
    difficulty: decodeDifficulty(sol.difficulty),
    // null = absent (pre-111) or undecodable; 0 = present-but-unreported.
    deviceAccessTimeUs: rawDevice == null || !Number.isFinite(device) ? null : device,
  };
}
```

`getQBlock`'s tail becomes `return qblockInfoFromSolution(sol, nonce);`.

- [ ] **Step 5: Run the tests + fix the compile fallout**

Run: `bun test apps/indexer/clients/substrate-client/client.test.ts`
Expected: PASS. Then run `bun run typecheck` if the repo has one (check `package.json` scripts; otherwise `bunx tsc --noEmit -p apps/indexer` or the repo's equivalent) — the new required field will flag every `QBlockInfo` literal (e.g. the fake client's test fixtures and `plugins.test.ts` `makeQBlock`). Fix ONLY compile errors here by adding `deviceAccessTimeUs: null`; the winners-plugin behavior change is Task 2's.

- [ ] **Step 6: Commit**

```bash
git add apps/indexer/clients/substrate-client/types.ts apps/indexer/clients/substrate-client/index.ts apps/indexer/clients/substrate-client/client.test.ts
# plus any fixture files the typecheck forced (list them explicitly)
git commit -m "feat(indexer): extract spec-111 deviceAccessTimeUs into QBlockInfo"
```

---

### Task 2: Winners plugin prefers the reported compute time

**Files:**
- Modify: `apps/indexer/pipeline/plugins/winners.ts` (~lines 71-89)
- Test: `apps/indexer/pipeline/plugins/plugins.test.ts` (`makeQBlock` ~line 55; winners describe block ~line 97)

**Interfaces:**
- Consumes: `QBlockInfo.deviceAccessTimeUs` from Task 1.
- Produces: `BlockRecord.miningTime` = reported seconds when truthy, else derived block-spacing (unchanged formula).

- [ ] **Step 1: Write the failing tests**

In `plugins.test.ts`, first make `makeQBlock` explicit about the default so every existing expectation (60s derived) still holds:

```typescript
    deviceAccessTimeUs: null,
```

(added to the object literal in `makeQBlock`, before `...overrides`). Then add to the winners describe block:

```typescript
  it("spec-111 reported compute time replaces the derived wall clock", async () => {
    await winnersPlugin().onBlock(
      makeCtx({ qblock: makeQBlock({ deviceAccessTimeUs: 45_500_000 }) }),
      db,
    );
    const [b] = await db.getRecentBlocks(10);
    expect(b?.miningTime).toBe(45.5); // µs → float seconds, not floored
  });

  it("deviceAccessTimeUs 0 (present but unreported) keeps the derived value", async () => {
    await winnersPlugin().onBlock(
      makeCtx({ qblock: makeQBlock({ deviceAccessTimeUs: 0 }) }),
      db,
    );
    const [b] = await db.getRecentBlocks(10);
    expect(b?.miningTime).toBe(60); // (500000 - 499990) blocks × 6s
  });
```

(The existing `qblock: null` and `lastProof: 0` tests already pin the pre-111 and no-anchor fallbacks.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/indexer/pipeline/plugins/plugins.test.ts`
Expected: the new 45.5 test FAILS (writes 60); everything else passes.

- [ ] **Step 3: Implement the preference in `winners.ts`**

Replace the miningTime computation (~lines 71-74):

```typescript
      // LastProofBlock is read at the PARENT hash: on_finalize updates it
      // in-block, so the parent's value is the prior tip.
      const miningTimeBlocks = lastProofBlock > 0 ? Math.max(1, e.blockNumber - lastProofBlock) : 0;
      // Spec-111 qblocks carry the winner's self-reported compute time
      // (QPU access time for QPU wins, wall clock for CPU/GPU), in µs.
      // Prefer it — the derived block-spacing wall clock below remains
      // recomputable from chain data by anyone, so nothing is lost.
      // Falsy (null = pre-111, 0 = unreported) falls back to the spacing.
      const miningTime = qblock?.deviceAccessTimeUs
        ? qblock.deviceAccessTimeUs / 1_000_000
        : miningTimeBlocks * BABE_SLOT_DURATION_SEC;
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/indexer/pipeline/plugins/plugins.test.ts`
Expected: ALL pass (new + existing, including the exact-BlockRecord equality test — its fixture default is `null` → derived 60).

- [ ] **Step 5: Commit**

```bash
git add apps/indexer/pipeline/plugins/winners.ts apps/indexer/pipeline/plugins/plugins.test.ts
git commit -m "feat(indexer): use reported device compute time as block mining_time"
```

---

### Task 3: Semantics docs + gate + MR

**Files:**
- Modify: `packages/shared/telemetry/chain.ts` (`BlockRecord.miningTime` ~line 26; `MiningHistoryRow.miningTime` comment ~line 249)
- Modify: `docs/DATABASE_SCHEMA.md` (`blocks.mining_time` row, ~line 56)
- Verification + MR.

**Interfaces:** documentation only; no code consumers change.

- [ ] **Step 1: Update the three semantic definitions**

`packages/shared/telemetry/chain.ts` — `BlockRecord.miningTime` gains a comment (currently bare `miningTime: number;`):

```typescript
  // Seconds of compute behind the winning proof. Spec-111+ blocks carry the
  // winner's self-reported device_access_time_us (QPU access time for QPU
  // wins, wall clock for CPU/GPU), converted µs → s. Pre-111 blocks and
  // unreported (0) wins fall back to derived block spacing
  // ((win − last proof) × slot seconds) — which stays recomputable from
  // chain data either way.
  miningTime: number;
```

`MiningHistoryRow.miningTime` comment (~line 249) — replace `// Seconds the winning proof took to mine.` with:

```typescript
  // Seconds of compute behind the winning proof (see BlockRecord.miningTime:
  // reported device time on spec-111+ wins, derived block spacing otherwise).
```

`docs/DATABASE_SCHEMA.md` `blocks.mining_time` row — replace the description `Seconds spent mining this block.` with:

```
Seconds of compute behind the win: miner-reported device time (µs→s, spec-111+) or derived block spacing for pre-111/unreported wins.
```

(The file was recently rewritten upstream — re-read the row's current text/alignment before editing and preserve the table formatting.)

- [ ] **Step 2: Gate**

Run, expecting green:

```bash
bun test apps/indexer/clients/substrate-client/client.test.ts apps/indexer/pipeline/plugins/plugins.test.ts
bun test apps/indexer
```

Plus the repo's lint/typecheck scripts if present in `package.json` (`bun run lint`, `bun run typecheck` or equivalents) — clean on touched files.

- [ ] **Step 3: Commit + push + MR**

```bash
git add packages/shared/telemetry/chain.ts docs/DATABASE_SCHEMA.md
git commit -m "docs: define mining_time as reported device time with fallback"
git push -u origin feat/qblock-device-access-time
glab mr create --target-branch v0.2 --title "feat(indexer): winner-reported device time as block mining_time" \
  --description "Dashboard side of quip-protocol-rs!53 (merged) + quip-protocol!143. Runtime spec 111 adds device_access_time_us (µs; QPU access time for QPU wins, wall clock for CPU/GPU) to the QBlock the winning_solution runtime API returns. The indexer now extracts it into QBlockInfo (null on pre-111 chains — polkadot-js decodes from chain metadata, so the field appears automatically at 111 activation) and the winners plugin stores it (µs→s) as blocks.mining_time; pre-111 and unreported (0) wins keep the derived block-spacing wall clock, which remains recomputable from chain data in all cases. No schema change, no frontend change — the mining-time chart's Y-values just get truer as 111 wins land."
```

---

## Rollout note

No deploy coupling: the indexer works identically before and after runtime 111 activates (the field simply starts appearing). Historical rows are not rewritten; the mining-time chart shows derived wall clock for old qblocks and reported compute time for new ones from the activation point forward.
