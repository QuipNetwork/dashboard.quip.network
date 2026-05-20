// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  BlockRecord,
  ChainMinerRecord,
  IndexerObservability,
  MinerStats,
} from "../../../types/telemetry";
import { useTelemetryStore } from "../../../store/telemetry-store";

import { useMyNode, type MyNodeStats } from "./use-my-node";

// ---- Fixtures ----------------------------------------------------------

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GAlice",
    energy: -100,
    diversity: 0.5,
    numValidSolutions: 1,
    qualityMilli: 800,
    miningTime: 60,
    reward: "1000000000000",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    finalized: false,
    ...overrides,
  };
}

function makeChainMiner(overrides: Partial<ChainMinerRecord> = {}): ChainMinerRecord {
  return {
    accountId: "5GAlice",
    deposit: "1000000000000",
    proofsSubmitted: "12",
    proofsWon: "7",
    rewardsEarned: "7000000000000",
    telemetryNodeAddress: null,
    hardware: null,
    ...overrides,
  };
}

function makeMinerStats(overrides: Partial<MinerStats> = {}): MinerStats {
  return {
    totalBlocksAttempted: 100,
    totalBlocksWon: 7,
    winRate: 0.07,
    totalMiningTime: 600,
    avgMiningTime: 6,
    headsObserved: 1000,
    contextsDispatched: 500,
    resultsReceived: 480,
    proofsSubmitted: 12,
    staleDrops: 2,
    submissionErrors: 0,
    ...overrides,
  };
}

function makeIndexer(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  return {
    chainHeadFromNode: "100",
    lastStatusFetchAt: "2026-01-01T00:00:00Z",
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: "100",
    finalizedBlockHeight: "100",
    chainConnected: true,
    minerStats: null,
    ...overrides,
  };
}

// ---- Render harness ----------------------------------------------------

function renderHook(): { current: MyNodeStats | null } {
  const result: { current: MyNodeStats | null } = { current: null };

  function Probe(): null {
    result.current = useMyNode();
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

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
    selfAddress: null,
    indexer: null,
    chainMiners: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---- Tests -------------------------------------------------------------

describe("useMyNode", () => {
  it("returns null-shaped output pre-self-discovery (selfAddress null)", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: null,
      indexer: null,
      chainMiners: [],
    });

    const out = renderHook();
    expect(out.current).toEqual({
      selfAddress: null,
      chainMinerEntry: null,
      minerStats: null,
      lastWonBlock: null,
      blocksMined: "0",
      currentRequirements: null,
    });
  });

  it("returns null chainMinerEntry + blocksMined='0' when self is known but not in chainMiners", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.selfAddress).toBe("5GAlice");
    expect(out.current?.chainMinerEntry).toBeNull();
    expect(out.current?.blocksMined).toBe("0");
    expect(out.current?.lastWonBlock).toBeNull();
    expect(out.current?.currentRequirements).toBeNull();
    expect(out.current?.minerStats).toBeNull();
  });

  it("returns chainMinerEntry + blocksMined from proofsWon when self is registered on-chain", () => {
    const miner = makeChainMiner({ accountId: "5GAlice", proofsWon: "7" });
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [miner],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.chainMinerEntry).toEqual(miner);
    expect(out.current?.blocksMined).toBe("7");
  });

  it("ignores chainMiners rows whose accountId doesn't match self", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [makeChainMiner({ accountId: "5GBob", proofsWon: "999" })],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.chainMinerEntry).toBeNull();
    expect(out.current?.blocksMined).toBe("0");
  });

  it("returns the most recent block whose minerId matches self as lastWonBlock", () => {
    const myBlock = makeBlock({ blockHash: "0xmine", minerId: "5GAlice" });
    const othersBlock = makeBlock({ blockHash: "0xtheirs", minerId: "5GBob" });
    // Store ships blocks DESC by substrateBlockNumber; .find returns the
    // first match, so the first matching row is the "most recent".
    useTelemetryStore.setState({
      blocks: [myBlock, othersBlock],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.lastWonBlock).toBe(myBlock);
  });

  it("returns null lastWonBlock when no block was mined by self", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock({ minerId: "5GBob" })],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.lastWonBlock).toBeNull();
  });

  it("populates currentRequirements from the tip block when blocks exist", () => {
    const tip = makeBlock({
      blockHash: "0xtip",
      difficultyEnergy: -123.5,
      minDiversity: 0.42,
      minSolutions: 9,
    });
    useTelemetryStore.setState({
      blocks: [tip],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.currentRequirements).toEqual({
      difficultyEnergy: -123.5,
      minDiversity: 0.42,
      minSolutions: 9,
    });
  });

  it("returns null currentRequirements pre-first-block (blocks empty)", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.currentRequirements).toBeNull();
  });

  it("forwards indexer.minerStats when present", () => {
    const stats = makeMinerStats({ totalBlocksWon: 42 });
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: makeIndexer({ minerStats: stats }),
    });

    const out = renderHook();
    expect(out.current?.minerStats).toEqual(stats);
  });

  it("returns null minerStats when indexer is null", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    const out = renderHook();
    expect(out.current?.minerStats).toBeNull();
  });

  it("returns null minerStats when indexer is present but minerStats is null", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: makeIndexer({ minerStats: null }),
    });

    const out = renderHook();
    expect(out.current?.minerStats).toBeNull();
  });
});
