// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerWinsRow } from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";

import { useNode, type NodeStats } from "./use-node";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GAlice",
    energy: -14_500,
    diversity: 0.5,
    numValidSolutions: 3,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -14_400,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function makeChainMiner(accountId: string, proofsWon: string): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: proofsWon,
    proofsWon,
    rewardsEarned: "5000000000000",
    telemetryNodeAddress: null,
    hardware: null,
  };
}

function makeWins(minerId: string, count: number): MinerWinsRow {
  return { minerId, wins: count, bestEnergy: -1, avgMiningTime: 10, lastWonAt: 1_700_000_000 };
}

function renderHook(accountId: string, minerWins: MinerWinsRow[] = []): { current: NodeStats } {
  const result = { current: {} as NodeStats };
  function Probe(): null {
    result.current = useNode(accountId, minerWins);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({
    blocks: [],
    chainMiners: [],
    nodeDescriptors: [],
    recentDifficulty: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useNode", () => {
  test("derives wins, last-won and synthetic submissions for the given account", () => {
    // DESC by block number, as the store ships. Bob wins the tip; Alice below.
    useTelemetryStore.setState({
      blocks: [
        makeBlock({
          blockHash: "0xb2",
          substrateBlockNumber: "102",
          minerId: "5GBob",
          energy: -14_600,
          qblockId: "3464",
        }),
        makeBlock({ blockHash: "0xa1", substrateBlockNumber: "101", minerId: "5GAlice" }),
        makeBlock({
          blockHash: "0xb0",
          substrateBlockNumber: "100",
          minerId: "5GBob",
          energy: -14_550,
          qblockId: "3450",
        }),
      ],
      chainMiners: [makeChainMiner("5GBob", "2"), makeChainMiner("5GAlice", "1")],
    });

    const bob = renderHook("5GBob", [makeWins("5GBob", 2), makeWins("5GAlice", 1)]).current;
    expect(bob.blocksMined).toBe("2"); // chain-authoritative proofs_won
    expect(bob.lastWonBlock?.blockHash).toBe("0xb2"); // most recent Bob win
    expect(bob.recentSubmissions).toHaveLength(2); // both Bob wins synthesized
    expect(bob.recentSubmissions.every((s) => s.chainOnly)).toBe(true);
    // QBlock# uses the chain qblockId, not a window-relative position.
    expect(bob.recentSubmissions.map((s) => s.solutionNumber).sort((a, b) => a - b)).toEqual([
      3450, 3464,
    ]);
  });

  test("locates the account's leaderboard rank and neighbors", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0x1", minerId: "5GBob" }),
        makeBlock({ blockHash: "0x2", minerId: "5GBob" }),
        makeBlock({ blockHash: "0x3", minerId: "5GAlice" }),
      ],
      chainMiners: [makeChainMiner("5GBob", "2"), makeChainMiner("5GAlice", "1")],
    });

    const alice = renderHook("5GAlice", [makeWins("5GBob", 2), makeWins("5GAlice", 1)]).current;
    expect(alice.self?.minerId).toBe("5GAlice");
    expect(alice.self?.rank).toBe(2); // ranked by chain proofs_won
    expect(alice.neighbors.some((n) => n.minerId === "5GBob")).toBe(true);
  });

  test("empty stats for an unknown account", () => {
    const ghost = renderHook("5GGhost").current;
    expect(ghost.blocksMined).toBe("0");
    expect(ghost.lastWonBlock).toBeNull();
    expect(ghost.recentSubmissions).toHaveLength(0);
    expect(ghost.self).toBeNull();
  });
});
