// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "./adapter";
import type {
  BlockRecord,
  MiningSubmissionRecord,
  QBlockParticipationRecord,
} from "@quip/shared/telemetry";
import { aggregateParticipationByCategory } from "@quip/shared/telemetry";
import { newInMemoryAdapter } from "../../test-helpers";

const rec = (overrides: Partial<QBlockParticipationRecord> = {}): QBlockParticipationRecord => ({
  qblockId: "5",
  account: "5Alice",
  kind: "Cpu",
  budgetSeconds: null,
  blockNumber: "100",
  ...overrides,
});

describe("qblock_participation adapter round-trip", () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await newInMemoryAdapter();
  });
  afterEach(async () => {
    await db.disconnect();
  });

  it("stores every participant of a qblock and reads them back sorted by account", async () => {
    await db.upsertQBlockParticipants([
      rec({ account: "5Charlie", kind: "QpuDwave", budgetSeconds: 90 }),
      rec({ account: "5Alice", kind: "Cpu" }),
      rec({ account: "5Bob", kind: "Gpu", budgetSeconds: 30 }),
    ]);

    const rows = await db.getQBlockParticipation("5");
    expect(rows.map((r) => r.account)).toEqual(["5Alice", "5Bob", "5Charlie"]);
    expect(rows.map((r) => r.kind)).toEqual(["Cpu", "Gpu", "QpuDwave"]);
    expect(rows.map((r) => r.budgetSeconds)).toEqual([null, 30, 90]);
    expect(rows.every((r) => r.qblockId === "5")).toBe(true);
  });

  it("is idempotent on (qblock_id, account) and updates the latest record in place", async () => {
    await db.upsertQBlockParticipants([rec({ account: "5Alice", budgetSeconds: null })]);
    // Same (qblock, account) re-declared with a budget — one row, updated.
    await db.upsertQBlockParticipants([
      rec({ account: "5Alice", kind: "QpuDwave", budgetSeconds: 120, blockNumber: "105" }),
    ]);

    const rows = await db.getQBlockParticipation("5");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account: "5Alice",
      kind: "QpuDwave",
      budgetSeconds: 120,
      blockNumber: "105",
    });
  });

  it("scopes reads to the requested qblock", async () => {
    await db.upsertQBlockParticipants([
      rec({ qblockId: "5", account: "5Alice" }),
      rec({ qblockId: "6", account: "5Alice" }),
    ]);
    expect(await db.getQBlockParticipation("5")).toHaveLength(1);
    expect(await db.getQBlockParticipation("6")).toHaveLength(1);
    expect(await db.getQBlockParticipation("7")).toEqual([]);
  });

  it("dropState deletes all participation rows", async () => {
    await db.upsertQBlockParticipants([rec(), rec({ account: "5Bob" })]);
    const deleted = await db.deleteAllQBlockParticipation();
    expect(deleted).toBe(2);
    expect(await db.getQBlockParticipation("5")).toEqual([]);
  });

  it("upserting an empty batch is a no-op", async () => {
    await db.upsertQBlockParticipants([]);
    expect(await db.getQBlockParticipation("5")).toEqual([]);
  });
});

const block = (overrides: Partial<BlockRecord> = {}): BlockRecord => ({
  blockHash: "0xpow",
  substrateBlockNumber: "100",
  substrateBlockHash: "0xsub",
  substrateParentHash: "0xpar",
  timestamp: 1_700_000_000,
  minerId: "5Winner",
  energy: -1,
  diversity: 0,
  numValidSolutions: 1,
  miningTime: 60,
  reward: "0",
  qblockId: "5",
  nonce: "1",
  numNodes: 1,
  numEdges: 0,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: true,
  topologyHash: null,
  deviceAccessTimeUs: null,
  ...overrides,
});

const submission = (overrides: Partial<MiningSubmissionRecord> = {}): MiningSubmissionRecord => ({
  solutionNumber: 5,
  minerId: "5Q",
  minerType: "QPU",
  tsNs: "1",
  energyMilli: -1,
  diversityMilli: 0,
  thresholdMilli: 0,
  lastProofBlockHash: "0x",
  extrinsicHash: null,
  chainBlockHash: null,
  chainBlockNumber: null,
  powSequence: null,
  outcome: "submitted_inblock",
  attemptCount: 1,
  bestEnergyMilli: -1,
  numValid: 1,
  qpuAccessTimeUs: 0,
  observedAt: "2023-11-14T00:00:00.000Z",
  ...overrides,
});

describe("getParticipationCompute (join participation + blocks + submissions)", () => {
  let db: DatabaseAdapter;
  beforeEach(async () => {
    db = await newInMemoryAdapter();
  });
  afterEach(async () => {
    await db.disconnect();
  });

  it("joins each participant to the qblock's mining time and their exact QPU access", async () => {
    await db.insertBlock(block({ qblockId: "5", miningTime: 60 }));
    await db.upsertQBlockParticipants([
      rec({ qblockId: "5", account: "5A", kind: "Cpu" }),
      rec({ qblockId: "5", account: "5Q", kind: "QpuDwave" }),
    ]);
    // Self-node telemetry for the QPU participant: exact chip-access time.
    await db.insertMiningSubmission(
      submission({ minerId: "5Q", solutionNumber: 5, qpuAccessTimeUs: 500_000 }),
    );

    const rows = await db.getParticipationCompute("2000-01-01T00:00:00.000Z");
    const byAccount = new Map(rows.map((r) => [r.account, r]));
    expect(byAccount.get("5A")).toMatchObject({
      qblockId: "5",
      kind: "Cpu",
      miningSeconds: 60,
      exactQpuAccessUs: null,
    });
    expect(byAccount.get("5Q")).toMatchObject({
      qblockId: "5",
      kind: "QpuDwave",
      miningSeconds: 60,
      exactQpuAccessUs: 500_000,
    });

    // End-to-end through the pure aggregator: CPU gets the full window, QPU
    // gets its exact 0.5s (not the wall estimate).
    const cats = aggregateParticipationByCategory(rows);
    const byCat = new Map(cats.map((c) => [c.category, c]));
    expect(byCat.get("CPU")).toMatchObject({ deviceAccessSeconds: 60, estimated: true });
    expect(byCat.get("QPU")).toMatchObject({ deviceAccessSeconds: 0.5, estimated: false });
  });

  it("excludes participation whose qblock's block row is outside the window", async () => {
    await db.insertBlock(block({ qblockId: "5", timestamp: 1_600_000_000 }));
    await db.upsertQBlockParticipants([rec({ qblockId: "5", account: "5A" })]);
    // Window starts after the block's timestamp → nothing.
    const rows = await db.getParticipationCompute("2023-11-14T00:00:00.000Z");
    expect(rows).toEqual([]);
  });

  it("omits participants whose qblock has no indexed block row yet", async () => {
    await db.upsertQBlockParticipants([rec({ qblockId: "9", account: "5A" })]);
    expect(await db.getParticipationCompute("2000-01-01T00:00:00.000Z")).toEqual([]);
  });
});
