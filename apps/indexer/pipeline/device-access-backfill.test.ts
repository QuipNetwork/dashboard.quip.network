// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-shot device_access_time backfill: detection matrix + the marker latch.
// The latch is the point — "every row null" can be a legitimate steady state
// (the field is self-reported and usually absent), so only the FIRST boot
// against a marker-less DB may decide, and its decision must stick across
// restarts and crashes.

import { beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { BlockRecord } from "@quip/shared/telemetry";

import { newInMemoryAdapter } from "../core/test-helpers";
import { ensureDeviceAccessTimeBackfill } from "./device-access-backfill";
import { winnersPlugin } from "./plugins/winners";
import type { Indexable } from "./plugin";

const sampleBlock = (overrides: Partial<BlockRecord> = {}): BlockRecord => ({
  blockHash: "0xpow1",
  substrateBlockNumber: "100",
  substrateBlockHash: "0xsub1",
  substrateParentHash: "0xsub0",
  timestamp: 1700000000,
  minerId: "5GPP",
  energy: -1.5,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 1.25,
  reward: "1000000000000",
  qblockId: "1",
  nonce: "1",
  numNodes: 2,
  numEdges: 3,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: false,
  topologyHash: null,
  deviceAccessTimeUs: null,
  ...overrides,
});

function registry(): Indexable[] {
  return [winnersPlugin()];
}

let db: DatabaseAdapter;
beforeEach(async () => {
  db = await newInMemoryAdapter();
});

describe("ensureDeviceAccessTimeBackfill", () => {
  it("all-null rows → triggers the winners reindex once and latches; second boot is a no-op", async () => {
    await db.insertBlock(sampleBlock({ blockHash: "0xa", substrateBlockNumber: "1" }));
    await db.insertBlock(sampleBlock({ blockHash: "0xb", substrateBlockNumber: "2" }));

    const first = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(first).toEqual({ status: "triggered", ranNow: true });
    // The real --reindex winners path ran: generation bumped, rows dropped.
    expect(await db.getIndexerGeneration("winners")).toBe(2);
    expect(await db.getRecentBlocks(10)).toHaveLength(0);
    expect(await db.getDeviceAccessTimeBackfillMarker()).toBe("triggered");

    // Second startup: still all-null (the re-walk hasn't refilled yet in
    // this simulation) — the latch, not the data, prevents a re-trigger.
    const second = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(second).toEqual({ status: "triggered", ranNow: false });
    expect(await db.getIndexerGeneration("winners")).toBe(2); // no second bump
  });

  it("fresh empty DB → latches 'not-needed' without reindexing", async () => {
    const decision = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(decision).toEqual({ status: "not-needed", ranNow: false });
    expect(await db.getDeviceAccessTimeBackfillMarker()).toBe("not-needed");
    expect(await db.getIndexerGeneration("winners")).toBe(1);

    // The steady state this feature must NOT fight: the deployment later
    // indexes rows that are all null because nobody reports the field.
    await db.insertBlock(sampleBlock());
    const later = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(later).toEqual({ status: "not-needed", ranNow: false });
    expect(await db.getIndexerGeneration("winners")).toBe(1);
    expect(await db.getRecentBlocks(10)).toHaveLength(1);
  });

  it("any reported device_access_time_us → latches 'not-needed', rows untouched", async () => {
    await db.insertBlock(sampleBlock({ blockHash: "0xa", substrateBlockNumber: "1" }));
    await db.insertBlock(
      sampleBlock({ blockHash: "0xb", substrateBlockNumber: "2", deviceAccessTimeUs: 45_500_000 }),
    );

    const decision = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(decision).toEqual({ status: "not-needed", ranNow: false });
    expect(await db.getDeviceAccessTimeBackfillMarker()).toBe("not-needed");
    expect(await db.getIndexerGeneration("winners")).toBe(1);
    expect(await db.getRecentBlocks(10)).toHaveLength(2);
  });

  it("crash after marker, mid-reindex → restart never schedules a second generation bump", async () => {
    await db.insertBlock(sampleBlock());

    // Simulate the crash window: marker latched and runReindex got through
    // its bump + coverage clear, but dropState never ran (rows survive).
    await db.setDeviceAccessTimeBackfillMarker("triggered");
    await db.bumpIndexerGeneration("winners");
    await db.clearCoverage("winners");

    const decision = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(decision).toEqual({ status: "triggered", ranNow: false });
    expect(await db.getIndexerGeneration("winners")).toBe(2); // still 2 — no re-bump
    // Completion is runReindex's own crash-safety contract: the cleared
    // coverage makes the next walk re-derive every winner row, and the
    // idempotent walk overwrites the survivors (reindex.test.ts, "crash
    // between coverage clear and dropState heals via the idempotent re-walk").
    expect(await db.getCoverage("winners")).toBeNull();
  });

  it("unrecognized marker value still latches (never re-triggers)", async () => {
    await db.insertBlock(sampleBlock());
    await db.setDeviceAccessTimeBackfillMarker("garbage");

    const decision = await ensureDeviceAccessTimeBackfill(db, registry());
    expect(decision).toEqual({ status: "triggered", ranNow: false });
    expect(await db.getIndexerGeneration("winners")).toBe(1);
    expect(await db.getRecentBlocks(10)).toHaveLength(1);
  });
});
