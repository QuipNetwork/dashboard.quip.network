// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import type { MinerCategory, ParticipationComputeRow } from "@quip/shared/telemetry";

import { countMinersByCategory } from "./use-active-nodes";

const row = (qblockId: string, account: string, kind: string): ParticipationComputeRow => ({
  qblockId,
  account,
  kind,
  miningSeconds: 60,
  exactQpuAccessUs: null,
});

describe("countMinersByCategory", () => {
  it("counts each account once under its primary category", () => {
    const index = new Map<string, MinerCategory>([["rig", "GPU"]]);
    const counts = countMinersByCategory(
      [row("1", "rig", "Cpu"), row("1", "rig", "Gpu"), row("2", "rig", "Cpu")],
      index,
    );
    expect(counts).toEqual(new Map([["GPU", 1]]));
  });

  it("falls back to the declared kind for accounts missing from the index", () => {
    const counts = countMinersByCategory(
      [
        row("1", "a", "Cpu"),
        row("2", "a", "Cpu"),
        row("1", "q", "QpuDwave"),
        row("1", "m", "Metal"),
      ],
      new Map(),
    );
    expect(counts).toEqual(
      new Map<MinerCategory, number>([
        ["CPU", 1],
        ["QPU", 1],
        ["GPU", 1],
      ]),
    );
  });
});
