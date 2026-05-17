// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { BlockRecord } from "../types/telemetry";
import { selectTipBlock, type TelemetryState } from "./telemetry-store";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    epoch: "1000000000",
    blockIndex: 0,
    blockHash: "hash",
    timestamp: 1_000_000_000,
    previousHash: "prev",
    minerId: "miner",
    minerCategory: "CPU",
    ecdsaPublicKey: "pk",
    energy: -100,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    substrateBlockNumber: null,
    substrateBlockHash: null,
    substrateParentHash: null,
    extrinsicsRoot: null,
    stateRoot: null,
    finalized: false,
    isCanonical: true,
    ...overrides,
  };
}

function makeState(blocks: BlockRecord[]): TelemetryState {
  return {
    blocks,
    nodes: null,
    selfAddress: null,
    indexer: null,
    serverTime: null,
    chainHead: null,
    babeEpoch: null,
    babeAuthorities: [],
    chainMiners: [],
    recentDifficulty: [],
    telemetryIndex: null,
    loading: false,
    error: null,
    fetchTelemetry: async () => {},
  };
}

describe("selectTipBlock", () => {
  it("returns null for an empty chain", () => {
    expect(selectTipBlock(makeState([]))).toBeNull();
  });

  it("returns the last element — the server ships blocks ascending", () => {
    const state = makeState([
      makeBlock({ blockIndex: 10, timestamp: 1000 }),
      makeBlock({ blockIndex: 11, timestamp: 2000 }),
      makeBlock({ blockIndex: 12, timestamp: 3000 }),
    ]);
    const tip = selectTipBlock(state);
    expect(tip?.blockIndex).toBe(12);
  });

  it("returns a stable reference (same BlockRecord identity across calls)", () => {
    const state = makeState([makeBlock({ blockIndex: 7 })]);
    expect(selectTipBlock(state)).toBe(selectTipBlock(state));
  });
});
