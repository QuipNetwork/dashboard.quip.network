// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerCategory } from "../types/telemetry";
import { useTelemetryStore } from "./telemetry-store";
import { useUIStore } from "./ui-store";
import { useFilteredBlocks } from "./use-filtered-blocks";

// ---- Fixtures ----------------------------------------------------------

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GPP",
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
    accountId: "5GPP",
    deposit: "1000",
    proofsSubmitted: "10",
    proofsWon: "3",
    rewardsEarned: "300",
    telemetryNodeAddress: null,
    ...overrides,
  };
}

// ---- Render harness ----------------------------------------------------

/**
 * Mount the hook in a tiny React tree so React's useMemo plumbing runs
 * end-to-end. We pull the value out via a ref so the test can assert on it
 * directly.
 */
function renderHook(): { current: BlockRecord[] | null } {
  const result: { current: BlockRecord[] | null } = { current: null };

  function Probe(): null {
    result.current = useFilteredBlocks();
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
    chainMiners: [],
  });
  // Default toggle behavior means the UI store never reaches 0 selectedTypes
  // via toggleMinerType. Tests need to drive it explicitly with setState.
  useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---- Tests -------------------------------------------------------------

describe("useFilteredBlocks", () => {
  it("returns all blocks when selectedTypes is empty (no filter active)", () => {
    const blocks = [makeBlock({ blockHash: "0xa" }), makeBlock({ blockHash: "0xb" })];
    useTelemetryStore.setState({ blocks, chainMiners: [] });
    useUIStore.setState({ selectedTypes: [] as MinerCategory[] });

    const out = renderHook();
    expect(out.current).toHaveLength(2);
    expect(out.current).toBe(blocks); // same reference — no copy
  });

  it("returns same array reference (no copy) when filter is inactive", () => {
    const blocks = [makeBlock({ blockHash: "0xa" })];
    useTelemetryStore.setState({ blocks });
    useUIStore.setState({ selectedTypes: [] as MinerCategory[] });

    const out = renderHook();
    expect(out.current).toBe(blocks);
  });

  it("filters all blocks out when active filter excludes OTHER (current degradation)", () => {
    // Today every chain miner falls back to category "OTHER" because the
    // primaryType field isn't surfaced yet. With selectedTypes=[CPU,GPU,QPU]
    // every block is dropped. Documents the placeholder behavior the hook
    // ships with until peer-query/primaryType joining lands.
    const blocks = [makeBlock({ minerId: "5GPP" }), makeBlock({ minerId: "5GQQ" })];
    useTelemetryStore.setState({
      blocks,
      chainMiners: [makeChainMiner({ accountId: "5GPP" })],
    });
    useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"] });

    const out = renderHook();
    expect(out.current).toEqual([]);
  });

  it("includes blocks when OTHER is in selectedTypes (with or without chain miner row)", () => {
    const known = makeBlock({ minerId: "5GPP", blockHash: "0xa" });
    const unknown = makeBlock({ minerId: "5GZZ", blockHash: "0xb" });
    useTelemetryStore.setState({
      blocks: [known, unknown],
      chainMiners: [makeChainMiner({ accountId: "5GPP" })],
    });
    useUIStore.setState({ selectedTypes: ["OTHER"] });

    const out = renderHook();
    expect(out.current).toHaveLength(2);
    expect(out.current?.map((b) => b.blockHash)).toEqual(["0xa", "0xb"]);
  });

  it("treats blocks whose minerId isn't in chainMiners as OTHER too", () => {
    const stray = makeBlock({ minerId: "5G-unknown", blockHash: "0xstray" });
    useTelemetryStore.setState({
      blocks: [stray],
      chainMiners: [makeChainMiner({ accountId: "5GPP" })], // different miner
    });
    useUIStore.setState({ selectedTypes: ["OTHER"] });

    const out = renderHook();
    expect(out.current).toEqual([stray]);
  });

  it("memoizes: same deps → same array reference across renders of the same tree", () => {
    const blocks = [makeBlock({ minerId: "5GPP" })];
    useTelemetryStore.setState({
      blocks,
      chainMiners: [makeChainMiner({ accountId: "5GPP" })],
    });
    useUIStore.setState({ selectedTypes: ["OTHER"] });

    // Capture the hook's output on first render, then force a re-render with
    // unchanged store state. useMemo should hand back the same filtered array.
    const seen: BlockRecord[][] = [];
    function Probe(): null {
      seen.push(useFilteredBlocks());
      return null;
    }

    act(() => {
      root.render(createElement(Probe));
    });
    act(() => {
      root.render(createElement(Probe));
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]);
  });
});
