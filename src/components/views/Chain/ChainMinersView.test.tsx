// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { ChainMinerRecord, NodeDescriptorRecord } from "../../../types/telemetry";
import { filterChainMiners } from "./ChainMinersView";

function miner(accountId: string): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
  };
}

function descriptor(
  accountId: string,
  nodeName: string,
  quipVersion: string,
): NodeDescriptorRecord {
  return {
    accountId,
    descriptor: { nodeName, runtime: { quipVersion } },
  } as unknown as NodeDescriptorRecord;
}

const MINERS = [miner("5Alpha"), miner("5Beta")];
const DESCRIPTORS = new Map<string, NodeDescriptorRecord>([
  ["5Alpha", descriptor("5Alpha", "alpha-rig", "0.3.1")],
  ["5Beta", descriptor("5Beta", "beta-rig", "0.2.9")],
]);

describe("filterChainMiners", () => {
  it("returns all miners for an empty query", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "")).toHaveLength(2);
  });

  it("matches on account id", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "beta").map((m) => m.accountId)).toEqual([
      "5Beta",
    ]);
  });

  it("matches on joined rig name", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "alpha-rig").map((m) => m.accountId)).toEqual([
      "5Alpha",
    ]);
  });

  it("matches on joined quip version", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "0.2.9").map((m) => m.accountId)).toEqual([
      "5Beta",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "zzz")).toHaveLength(0);
  });
});
