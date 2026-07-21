// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { ChainMinerRecord } from "@quip/shared/telemetry";
import { sortChainMiners, type MinerSortKeys, type MinerSortState } from "./use-chain-miner-sort";

function miner(accountId: string, overrides: Partial<ChainMinerRecord> = {}): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
    ...overrides,
  };
}

const NO_KEYS: MinerSortKeys = {
  nameFor: (id) => id,
  versionFor: () => null,
  participationTsFor: () => null,
};

function ids(rows: ChainMinerRecord[]): string[] {
  return rows.map((r) => r.accountId);
}

function sort(column: MinerSortState["column"], direction: MinerSortState["direction"]) {
  return { column, direction } satisfies MinerSortState;
}

describe("sortChainMiners", () => {
  it("sorts by last participation with missing timestamps last in both directions", () => {
    const rows = [miner("5None"), miner("5Old"), miner("5New")];
    const keys: MinerSortKeys = {
      ...NO_KEYS,
      participationTsFor: (id) => (id === "5New" ? 200 : id === "5Old" ? 100 : null),
    };
    expect(ids(sortChainMiners(rows, sort("lastParticipation", "desc"), keys))).toEqual([
      "5New",
      "5Old",
      "5None",
    ]);
    expect(ids(sortChainMiners(rows, sort("lastParticipation", "asc"), keys))).toEqual([
      "5Old",
      "5New",
      "5None",
    ]);
  });

  it("sorts u64/u128 string counters numerically past Number.MAX_SAFE_INTEGER", () => {
    const rows = [
      miner("5Small", { rewardsEarned: "9" }),
      miner("5Huge", { rewardsEarned: "36893488147419103232" }), // 2^65
      miner("5Big", { rewardsEarned: "18446744073709551616" }), // 2^64
    ];
    expect(ids(sortChainMiners(rows, sort("rewards", "desc"), NO_KEYS))).toEqual([
      "5Huge",
      "5Big",
      "5Small",
    ]);
  });

  it("sorts deposit, proofs submitted, and proofs won by their own columns", () => {
    const rows = [
      miner("5A", { deposit: "5", proofsSubmitted: "1", proofsWon: "9" }),
      miner("5B", { deposit: "7", proofsSubmitted: "3", proofsWon: "2" }),
    ];
    expect(ids(sortChainMiners(rows, sort("deposit", "desc"), NO_KEYS))).toEqual(["5B", "5A"]);
    expect(ids(sortChainMiners(rows, sort("proofsSubmitted", "asc"), NO_KEYS))).toEqual([
      "5A",
      "5B",
    ]);
    expect(ids(sortChainMiners(rows, sort("proofsWon", "desc"), NO_KEYS))).toEqual(["5A", "5B"]);
  });

  it("sorts by display name case-insensitively", () => {
    const rows = [miner("5x"), miner("5y"), miner("5z")];
    const keys: MinerSortKeys = {
      ...NO_KEYS,
      nameFor: (id) => (id === "5x" ? "Zeta-rig" : id === "5y" ? "alpha-rig" : "Mid-rig"),
    };
    expect(ids(sortChainMiners(rows, sort("miner", "asc"), keys))).toEqual(["5y", "5z", "5x"]);
  });

  it("sorts by version with missing versions last in both directions", () => {
    const rows = [miner("5NoVer"), miner("5V2"), miner("5V1")];
    const keys: MinerSortKeys = {
      ...NO_KEYS,
      versionFor: (id) => (id === "5V2" ? "0.3.1" : id === "5V1" ? "0.2.9" : null),
    };
    expect(ids(sortChainMiners(rows, sort("version", "desc"), keys))).toEqual([
      "5V2",
      "5V1",
      "5NoVer",
    ]);
    expect(ids(sortChainMiners(rows, sort("version", "asc"), keys))).toEqual([
      "5V1",
      "5V2",
      "5NoVer",
    ]);
  });

  it("does not mutate the input array", () => {
    const rows = [miner("5B", { deposit: "2" }), miner("5A", { deposit: "1" })];
    sortChainMiners(rows, sort("deposit", "asc"), NO_KEYS);
    expect(ids(rows)).toEqual(["5B", "5A"]);
  });
});
