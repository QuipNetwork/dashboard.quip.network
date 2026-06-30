// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  BlockRecord,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  MinerStats,
} from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";

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
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
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
    headsObserved: 1000,
    contextsDispatched: 500,
    resultsReceived: 480,
    proofsSubmitted: 12,
    staleDrops: 2,
    submissionErrors: 0,
    duplicateResultDrops: 0,
    ...overrides,
  };
}

function makeDifficulty(overrides: Partial<DifficultyRecord> = {}): DifficultyRecord {
  return {
    observedAtBlock: "100",
    difficultyEnergy: -1.234,
    minDiversity: 0.5,
    minSolutions: 5,
    observedAt: "2026-05-21T00:00:00Z",
    topologyHash: null,
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
    recentDifficulty: [],
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
      modes: undefined,
      lastWonBlock: null,
      lastWonProblemNumber: null,
      blocksMined: "0",
      selfAvgMiningTimeSec: null,
      currentRequirements: null,
      self: null,
      neighbors: [],
      recentSubmissions: [],
      effectiveMinerStats: null,
      effectiveProblemsAttempted: 0,
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

  it("blocksMined trails chain when local has fresh win not yet in chain_miners poll", () => {
    // Indexer captured a winning block before the chain_miners poll
    // refreshed: local count is 1 but chain_miners.proofsWon is still 0.
    // We deliberately trail chain's authoritative count rather than max(),
    // because the previous max() behavior over-counted on stale local DBs
    // across chain rebuilds. The tile will catch up on the next
    // chain_miners poll (default 6s) — small enough to prefer correctness.
    useTelemetryStore.setState({
      blocks: [makeBlock({ blockHash: "0xa", minerId: "5GAlice" })],
      selfAddress: "5GAlice",
      chainMiners: [makeChainMiner({ accountId: "5GAlice", proofsWon: "0" })],
      indexer: null,
    });
    expect(renderHook().current?.blocksMined).toBe("0");
  });

  it("blocksMined falls back to chain count when chain reports more than local", () => {
    // Indexer just started and hasn't backfilled historical wins yet, but
    // chain_miners.proofsWon already reflects them. Tile should show 7,
    // not 0, even though the local blocks table is empty for self.
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [makeChainMiner({ accountId: "5GAlice", proofsWon: "7" })],
      indexer: null,
    });
    expect(renderHook().current?.blocksMined).toBe("7");
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

  it("populates currentRequirements from recentDifficulty[0] when blocks are empty", () => {
    // Wipe-on-drift case: indexer just restarted, no winning proofs since
    // boot so `blocks` is empty, but the first `current_difficulty()` poll
    // already wrote a row. The card should show the live chain threshold,
    // not "Awaiting first block" indefinitely.
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
      recentDifficulty: [
        makeDifficulty({
          difficultyEnergy: -2.5,
          minDiversity: 0.162,
          minSolutions: 1,
        }),
      ],
    });

    const out = renderHook();
    expect(out.current?.currentRequirements).toEqual({
      difficultyEnergy: -2.5,
      minDiversity: 0.162,
      minSolutions: 1,
    });
  });

  it("prefers recentDifficulty[0] over tipBlock when both are present", () => {
    // recentDifficulty is the live decayed value from `current_difficulty()`;
    // tipBlock's per-block snapshot reflects the threshold a (possibly old)
    // winning proof had to clear. When both exist, the live poll wins.
    const tip = makeBlock({
      blockHash: "0xtip",
      difficultyEnergy: -99,
      minDiversity: 0.99,
      minSolutions: 99,
    });
    useTelemetryStore.setState({
      blocks: [tip],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
      recentDifficulty: [
        makeDifficulty({
          difficultyEnergy: -1.1,
          minDiversity: 0.1,
          minSolutions: 1,
        }),
      ],
    });

    const out = renderHook();
    expect(out.current?.currentRequirements).toEqual({
      difficultyEnergy: -1.1,
      minDiversity: 0.1,
      minSolutions: 1,
    });
  });

  it("forwards indexer.minerStats when present", () => {
    const stats = makeMinerStats({ proofsSubmitted: 42 });
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

  // ---- lastWonProblemNumber ----------------------------------------------

  it("lastWonProblemNumber = chain-wide 1-based ASC position of latest self-win", () => {
    // blocks DESC by substrateBlockNumber; ours is the third newest of 5
    // total, so problem # = 5 - 2 = 3 (chain-wide).
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0x5", substrateBlockNumber: "500", minerId: "5GBob" }),
        makeBlock({ blockHash: "0x4", substrateBlockNumber: "400", minerId: "5GBob" }),
        makeBlock({ blockHash: "0xMINE", substrateBlockNumber: "300", minerId: "5GAlice" }),
        makeBlock({ blockHash: "0x2", substrateBlockNumber: "200", minerId: "5GBob" }),
        makeBlock({ blockHash: "0x1", substrateBlockNumber: "100", minerId: "5GBob" }),
      ],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });

    expect(renderHook().current?.lastWonProblemNumber).toBe(3);
  });

  it("lastWonProblemNumber null when self has no chain wins yet", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock({ minerId: "5GBob" })],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
    });
    expect(renderHook().current?.lastWonProblemNumber).toBeNull();
  });

  // ---- recentSubmissions merge -------------------------------------------

  it("recentSubmissions synthesizes chain-only rows for self-wins without local mining_submissions", () => {
    // Miner reset wiped mining_submissions; chain still has 2 self-wins
    // and 1 unrelated win. The 2 wins should appear as chainOnly rows.
    useTelemetryStore.setState({
      blocks: [
        makeBlock({
          blockHash: "0xmine2",
          substrateBlockNumber: "200",
          minerId: "5GAlice",
          timestamp: 1_700_000_200,
          energy: -150.5,
          numValidSolutions: 8,
        }),
        makeBlock({
          blockHash: "0xother",
          substrateBlockNumber: "150",
          minerId: "5GBob",
          timestamp: 1_700_000_150,
        }),
        makeBlock({
          blockHash: "0xmine1",
          substrateBlockNumber: "100",
          minerId: "5GAlice",
          timestamp: 1_700_000_100,
          energy: -140.25,
        }),
      ],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
      recentMiningSubmissions: [], // wiped
    });

    const rows = renderHook().current?.recentSubmissions ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.chainOnly === true)).toBe(true);
    // DESC by tsNs — newer chain block (#200) lands first.
    expect(rows[0]?.chainBlockNumber).toBe("200");
    expect(rows[0]?.energyMilli).toBe(-150500);
    expect(rows[0]?.numValid).toBe(8);
    // Sol # = the block's rank among all 3 winning blocks (DESC: #200 is
    // newest → solution 3; #150 → 2; #100 → 1). NOT the block height.
    expect(rows[0]?.solutionNumber).toBe(3);
    expect(rows[1]?.chainBlockNumber).toBe("100");
    expect(rows[1]?.solutionNumber).toBe(1);
  });

  it("recentSubmissions de-dupes chain-only rows against existing local rows by chainBlockNumber", () => {
    // mining_submissions already has a row for block #200 (full
    // fidelity). The chain block at #200 should NOT spawn a synthetic
    // duplicate. Block #100 has no local match → synthetic row.
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xb", substrateBlockNumber: "200", minerId: "5GAlice" }),
        makeBlock({ blockHash: "0xa", substrateBlockNumber: "100", minerId: "5GAlice" }),
      ],
      selfAddress: "5GAlice",
      chainMiners: [],
      indexer: null,
      recentMiningSubmissions: [
        {
          solutionNumber: 42,
          minerId: "5GAlice",
          minerType: "QPU",
          tsNs: String(BigInt(1_700_000_200) * 1_000_000_000n),
          energyMilli: -150_000,
          diversityMilli: 200,
          thresholdMilli: -160_000,
          lastProofBlockHash: "",
          extrinsicHash: null,
          chainBlockHash: "0xb",
          chainBlockNumber: "200",
          powSequence: null,
          outcome: "submitted_inblock",
          attemptCount: 33,
          bestEnergyMilli: -150_000,
          numValid: 5,
          qpuAccessTimeUs: 0,
          observedAt: "2026-05-26T00:00:00Z",
        },
      ],
    });

    const rows = renderHook().current?.recentSubmissions ?? [];
    expect(rows).toHaveLength(2);
    // The local row keeps its own solutionNumber (42) + attemptCount; the
    // synthetic row for #100 derives its solution_number from rank among
    // the 2 winning blocks (#100 is oldest → solution 1).
    const local = rows.find((r) => r.chainBlockNumber === "200");
    const synth = rows.find((r) => r.chainBlockNumber === "100");
    expect(local?.chainOnly).toBeUndefined();
    expect(local?.attemptCount).toBe(33);
    expect(local?.solutionNumber).toBe(42);
    expect(synth?.chainOnly).toBe(true);
    expect(synth?.solutionNumber).toBe(1);
  });

  // ---- effective (chain-floored) counters --------------------------------

  it("effectiveMinerStats.proofsSubmitted = max(local controller, chain proofsSubmitted)", () => {
    // Post-restart: local controller reset to 1, chain knows about 5
    // lifetime submissions. The floored value carries the chain truth
    // so the headline tile doesn't lie.
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [makeChainMiner({ accountId: "5GAlice", proofsSubmitted: "5" })],
      indexer: makeIndexer({ minerStats: makeMinerStats({ proofsSubmitted: 1 }) }),
    });

    expect(renderHook().current?.effectiveMinerStats?.proofsSubmitted).toBe(5);
  });

  it("effectiveProblemsAttempted floors at chain proofsSubmitted", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [makeChainMiner({ accountId: "5GAlice", proofsSubmitted: "8" })],
      indexer: null,
      selfProblemsAttempted: 2,
    });

    expect(renderHook().current?.effectiveProblemsAttempted).toBe(8);
  });

  it("effectiveMinerStats null when no MinerStats payload has landed yet", () => {
    useTelemetryStore.setState({
      blocks: [],
      selfAddress: "5GAlice",
      chainMiners: [makeChainMiner({ proofsSubmitted: "5" })],
      indexer: null,
    });
    expect(renderHook().current?.effectiveMinerStats).toBeNull();
  });
});
