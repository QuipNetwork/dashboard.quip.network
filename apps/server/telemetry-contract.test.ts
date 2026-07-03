// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R10 certification gate (spec §12, §15.8): /api/telemetry served from a DB
// in the exact state a PRE-redesign deployment reaches right after migration
// 0005 — legacy authorship counters, no row-per-block facts yet, poll-sourced
// difficulty rows — must produce a superset of the pre-redesign payload:
// same shapes, same values, additions only. This gate blocks merging the
// step-7 worker swap.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createPgliteHarness, type PgliteHarness } from "@quip/core/db/pglite-support";
import type { TelemetryResponse } from "@quip/shared/telemetry";
import { createApp } from "./app";

let harness: PgliteHarness;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  harness = await createPgliteHarness({ closeAdapterOnDisconnect: false });
});

afterAll(async () => {
  await harness.close();
});

const LEGACY_AT_A = "2026-06-01T00:00:00.000Z";
const LEGACY_AT_B = "2026-06-02T00:00:00.000Z";

async function seedPreRedesignDb(): Promise<void> {
  const db = harness.adapter;
  await db.insertBlock({
    blockHash: "0xcert",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xcert",
    substrateParentHash: "0xprev",
    timestamp: 1_700_000_000,
    minerId: "5GMiner",
    energy: -14.5,
    diversity: 0.4,
    numValidSolutions: 2,
    miningTime: 12,
    reward: "1000000000000",
    qblockId: "42",
    nonce: "7",
    numNodes: 64,
    numEdges: 128,
    difficultyEnergy: -14.4,
    minDiversity: 0.1,
    minSolutions: 1,
    finalized: true,
    topologyHash: null,
  });
  // Pre-redesign difficulty rows: the poll path was the only writer, and
  // migration 0005 backfills them as source='poll'.
  await db.insertDifficultySnapshot({
    observedAtBlock: "90",
    difficultyEnergy: -14.3,
    minDiversity: 0.1,
    minSolutions: 1,
    observedAt: "2026-06-01T10:00:00.000Z",
    topologyHash: null,
    source: "poll",
  });
  await db.upsertChainMiners([
    {
      accountId: "5GMiner",
      deposit: "1000",
      proofsSubmitted: "10",
      proofsWon: "3",
      rewardsEarned: "3000",
    },
  ]);
  await db.upsertBabeEpoch({
    epochIndex: 1,
    currentSlot: "2400",
    epochStartSlot: "0",
    slotsPerEpoch: 2400,
    currentSlotInEpoch: 0,
    authorityCount: 2,
  });
  await db.upsertBabeAuthorities(1, [
    { accountId: "5ValA", displayName: null },
    { accountId: "5ValB", displayName: null },
  ]);
  // The legacy counter table exactly as the old increment path left it:
  // lifetime counts that the new row-per-block table cannot reproduce yet.
  await harness.db
    .insertInto("validator_authorship")
    .values([
      {
        account_id: "5ValA",
        blocks_authored: "5",
        blocks_authored_with_pow: "2",
        last_authored_block: "9",
        last_authored_at: LEGACY_AT_A,
      },
      {
        account_id: "5ValB",
        blocks_authored: "3",
        blocks_authored_with_pow: "0",
        last_authored_block: "7",
        last_authored_at: LEGACY_AT_B,
      },
    ])
    .execute();
}

async function fetchTelemetry(): Promise<TelemetryResponse> {
  const res = await app.fetch(new Request("http://test/api/telemetry"));
  expect(res.status).toBe(200);
  // Compile-time contract: the payload must satisfy the shared type.
  return (await res.json()) as TelemetryResponse;
}

function validator(body: TelemetryResponse, accountId: string) {
  const v = body.validators.find((x) => x.accountId === accountId);
  expect(v).toBeDefined();
  return v!;
}

beforeEach(async () => {
  await harness.reset();
  await seedPreRedesignDb();
  app = createApp({
    db: harness.adapter,
    validatorRpcUrls: ["ws://test-validator:9944"],
    enableStatic: false,
    // The 1s snapshot cache would serve stale payloads across the
    // multi-fetch assertions below.
    telemetryCacheTtlMs: 0,
  });
});

describe("R10 certification — pre-redesign fixture superset", () => {
  test("every pre-redesign field is present with identical values", async () => {
    const body = await fetchTelemetry();

    // The pre-redesign payload's top-level surface — all must exist.
    for (const key of [
      "blocks",
      "chainMiners",
      "recentDifficulty",
      "validators",
      "nodes",
      "indexer",
      "chainHead",
    ] as const) {
      expect(body).toHaveProperty(key);
    }

    // blocks: byte-for-byte the row the old writer produced.
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toMatchObject({
      blockHash: "0xcert",
      substrateBlockNumber: "100",
      qblockId: "42",
      minerId: "5GMiner",
      miningTime: 12,
      difficultyEnergy: -14.4,
      finalized: true,
    });

    // recentDifficulty: same rows; `source` is the one additive field.
    expect(body.recentDifficulty).toHaveLength(1);
    expect(body.recentDifficulty[0]).toMatchObject({
      observedAtBlock: "90",
      difficultyEnergy: -14.3,
      minSolutions: 1,
      observedAt: "2026-06-01T10:00:00.000Z",
    });

    expect(body.chainMiners[0]).toMatchObject({
      accountId: "5GMiner",
      proofsWon: "3",
      rewardsEarned: "3000",
    });

    // validators: the legacy lifetime counters, served verbatim through the
    // union read (new table empty ⇒ legacy floor is the value).
    expect(validator(body, "5ValA")).toMatchObject({
      blocksAuthored: 5,
      blocksAuthoredWithPow: 2,
      lastAuthoredBlock: "9",
      lastAuthoredAt: LEGACY_AT_A,
    });
    expect(validator(body, "5ValB")).toMatchObject({
      blocksAuthored: 3,
      blocksAuthoredWithPow: 0,
      lastAuthoredBlock: "7",
      lastAuthoredAt: LEGACY_AT_B,
    });
  });

  test("authorship values never freeze: new tip blocks reflect immediately", async () => {
    // The walk starts writing row-per-block facts; the union takes the
    // newer last-authored side while legacy counts still floor the totals.
    await harness.adapter.recordValidatorAuthorship("5ValA", "10", 1_750_000_000, true);
    const body = await fetchTelemetry();
    const a = validator(body, "5ValA");
    expect(a.blocksAuthored).toBe(5); // GREATEST(legacy 5, new 1) — no regression
    expect(a.lastAuthoredBlock).toBe("10"); // no freeze — the fresh block shows
    expect(a.lastAuthoredAt).toBe(new Date(1_750_000_000 * 1000).toISOString());
  });

  test("authorship values never regress: cutover waits for every validator", async () => {
    const db = harness.adapter;
    // 5ValA's new-table count catches up (5 ≥ 5)…
    for (let n = 10; n < 15; n++) {
      await db.recordValidatorAuthorship("5ValA", String(n), 1_750_000_000 + n, n % 2 === 0);
    }
    // …but 5ValB is still behind (0 < 3): cutover must refuse.
    expect(await db.tryAuthorshipCutover()).toBe(false);
    let body = await fetchTelemetry();
    expect(validator(body, "5ValA").blocksAuthored).toBe(5);
    expect(validator(body, "5ValB").blocksAuthored).toBe(3); // floored, not zeroed

    // 5ValB catches up: cutover flips and values only jump up, never down.
    for (const n of ["20", "21", "22"]) {
      await db.recordValidatorAuthorship("5ValB", n, 1_750_000_100, false);
    }
    expect(await db.tryAuthorshipCutover()).toBe(true);
    body = await fetchTelemetry();
    expect(validator(body, "5ValA").blocksAuthored).toBe(5);
    expect(validator(body, "5ValB").blocksAuthored).toBe(3);
    expect(validator(body, "5ValB").lastAuthoredBlock).toBe("22");
  });
});
