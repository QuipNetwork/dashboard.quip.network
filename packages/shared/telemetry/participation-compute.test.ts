// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import {
  QPU_ACCESS_TO_WALL_RATIO,
  aggregateParticipationByCategory,
  aggregateParticipationByQblock,
  minerKindToCategory,
  participationFromQblockFiles,
  resolveParticipantAccessTime,
  type ParticipationComputeRow,
  type QblockTimingFile,
} from "./participation-compute";

describe("minerKindToCategory", () => {
  it("maps raw MinerKind variants to dashboard categories", () => {
    expect(minerKindToCategory("Cpu")).toBe("CPU");
    expect(minerKindToCategory("Gpu")).toBe("GPU");
    expect(minerKindToCategory("Metal")).toBe("GPU");
    expect(minerKindToCategory("QpuDwave")).toBe("QPU");
    expect(minerKindToCategory("QpuIbm")).toBe("QPU");
    expect(minerKindToCategory("QpuIonq")).toBe("QPU");
    expect(minerKindToCategory("QpuPasqal")).toBe("QPU");
  });
  it("falls back to OTHER for unknown kinds", () => {
    expect(minerKindToCategory("Fpga")).toBe("OTHER");
    expect(minerKindToCategory("")).toBe("OTHER");
  });
});

describe("resolveParticipantAccessTime", () => {
  it("charges CPU/GPU/OTHER the full block-active window (estimated)", () => {
    expect(resolveParticipantAccessTime({ category: "CPU", miningSeconds: 60 })).toEqual({
      deviceAccessSeconds: 60,
      estimated: true,
    });
    expect(resolveParticipantAccessTime({ category: "GPU", miningSeconds: 42 })).toEqual({
      deviceAccessSeconds: 42,
      estimated: true,
    });
  });

  it("estimates QPU access from the wall window via the h0 ratio", () => {
    const r = resolveParticipantAccessTime({ category: "QPU", miningSeconds: 74.89 });
    expect(r.estimated).toBe(true);
    // 74.89 / 74.89 == 1s of accumulated chip access over that window.
    expect(r.deviceAccessSeconds).toBeCloseTo(1, 6);
  });

  it("prefers exact QPU telemetry (self-node) over the estimate", () => {
    const r = resolveParticipantAccessTime({
      category: "QPU",
      miningSeconds: 100,
      exactQpuAccessUs: 250_000, // 0.25s reported
    });
    expect(r).toEqual({ deviceAccessSeconds: 0.25, estimated: false });
  });

  it("treats null/0 exact QPU access as unavailable and estimates", () => {
    for (const exact of [null, 0, undefined]) {
      const r = resolveParticipantAccessTime({
        category: "QPU",
        miningSeconds: 149.78,
        exactQpuAccessUs: exact,
      });
      expect(r.estimated).toBe(true);
      expect(r.deviceAccessSeconds).toBeCloseTo(149.78 / QPU_ACCESS_TO_WALL_RATIO, 6);
    }
  });
});

const row = (o: Partial<ParticipationComputeRow> = {}): ParticipationComputeRow => ({
  qblockId: "5",
  account: "5A",
  kind: "Cpu",
  miningSeconds: 60,
  exactQpuAccessUs: null,
  ...o,
});

describe("aggregateParticipationByCategory", () => {
  it("sums device-access + mining seconds per category across all rows", () => {
    const out = aggregateParticipationByCategory([
      row({ account: "5A", kind: "Cpu", miningSeconds: 60 }),
      row({ account: "5B", kind: "Cpu", miningSeconds: 40 }),
      row({ account: "5C", kind: "Gpu", miningSeconds: 30 }),
      row({ account: "5D", kind: "QpuDwave", miningSeconds: 74.89 }),
    ]);
    const byCat = new Map(out.map((c) => [c.category, c]));

    expect(byCat.get("CPU")).toMatchObject({
      participantCount: 2,
      deviceAccessSeconds: 100,
      miningSeconds: 100,
      estimated: true,
    });
    expect(byCat.get("GPU")).toMatchObject({ participantCount: 1, deviceAccessSeconds: 30 });
    // QPU: 74.89 wall → ~1s chip access, but miningSeconds still records the
    // raw window separately (the two are deliberately distinct).
    const qpu = byCat.get("QPU")!;
    expect(qpu.participantCount).toBe(1);
    expect(qpu.deviceAccessSeconds).toBeCloseTo(1, 6);
    expect(qpu.miningSeconds).toBeCloseTo(74.89, 6);
  });

  it("flags a category estimated when any contribution was estimated, exact otherwise", () => {
    const out = aggregateParticipationByCategory([
      row({ kind: "QpuDwave", account: "5A", miningSeconds: 100, exactQpuAccessUs: 500_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "QPU", estimated: false, deviceAccessSeconds: 0.5 });
  });
});

describe("aggregateParticipationByQblock", () => {
  it("groups per qblock then per category", () => {
    const out = aggregateParticipationByQblock([
      row({ qblockId: "5", account: "5A", kind: "Cpu", miningSeconds: 60 }),
      row({ qblockId: "5", account: "5B", kind: "Gpu", miningSeconds: 60 }),
      row({ qblockId: "6", account: "5A", kind: "Cpu", miningSeconds: 30 }),
    ]);
    expect(out.get("5")?.map((c) => c.category).sort()).toEqual(["CPU", "GPU"]);
    expect(out.get("6")).toHaveLength(1);
    expect(out.get("6")?.[0]).toMatchObject({ category: "CPU", deviceAccessSeconds: 30 });
  });
});

// Shape written by the Rust indexer's qblock file writer (see
// crates/quip-dashboard/src/indexer/file_writer.rs): raw participation rows
// plus the winner block, never a precomputed miningSeconds.
const qblockFile = (
  qblockId: string,
  winnerTimestamp: number | null,
  accounts: [string, string][],
): QblockTimingFile => ({
  qblockId,
  winner: winnerTimestamp === null ? null : { timestamp: winnerTimestamp },
  participation: accounts.map(([account, kind]) => ({
    account,
    kind,
    qblockId,
    blockNumber: "1",
    budgetSeconds: null,
  })),
});

describe("participationFromQblockFiles", () => {
  it("charges each participant the gap since the previous winner", () => {
    const rows = participationFromQblockFiles([
      qblockFile("11", 1_300, [["5B", "Gpu"]]),
      qblockFile("9", 1_000, [["5A", "Cpu"]]),
      qblockFile("10", 1_060, [
        ["5A", "Cpu"],
        ["5Q", "QpuDwave"],
      ]),
    ]);
    expect(rows).toEqual([
      { qblockId: "10", account: "5A", kind: "Cpu", miningSeconds: 60, exactQpuAccessUs: null },
      { qblockId: "10", account: "5Q", kind: "QpuDwave", miningSeconds: 60, exactQpuAccessUs: null },
      { qblockId: "11", account: "5B", kind: "Gpu", miningSeconds: 240, exactQpuAccessUs: null },
    ]);
  });

  it("compares qblock ids numerically, not lexically", () => {
    const rows = participationFromQblockFiles([
      qblockFile("10", 2_000, [["5A", "Cpu"]]),
      qblockFile("9", 1_000, [["5A", "Cpu"]]),
    ]);
    expect(rows).toEqual([
      { qblockId: "10", account: "5A", kind: "Cpu", miningSeconds: 1_000, exactQpuAccessUs: null },
    ]);
  });

  it("skips qblocks without a winner and measures across them", () => {
    const rows = participationFromQblockFiles([
      qblockFile("1", 100, []),
      qblockFile("2", null, [["5A", "Cpu"]]),
      qblockFile("3", 400, [["5B", "Cpu"]]),
    ]);
    expect(rows).toEqual([
      { qblockId: "3", account: "5B", kind: "Cpu", miningSeconds: 300, exactQpuAccessUs: null },
    ]);
  });

  it("drops non-positive gaps", () => {
    const rows = participationFromQblockFiles([
      qblockFile("1", 100, []),
      qblockFile("2", 100, [["5A", "Cpu"]]),
    ]);
    expect(rows).toEqual([]);
  });
});
