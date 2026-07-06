// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerHardwareRecord } from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";

import { EnergyDistributionCard } from "./EnergyDistributionCard";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GCpu",
    energy: -15_600,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -15_500,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function makeChainMiner(accountId: string, type: "CPU" | "GPU" | "QPU"): ChainMinerRecord {
  const hardware: MinerHardwareRecord = {
    accountId,
    nodeId: `node-${accountId}`,
    miners: [{ id: `${accountId}-${type}-1`, type }],
    primaryType: type,
    source: "self",
    observedAt: "2026-05-26T00:00:00Z",
  };
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ blocks: [], chainMiners: [], nodeDescriptors: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => root.render(createElement(EnergyDistributionCard)));
}

describe("EnergyDistributionCard", () => {
  test("renders the title, the new subtitle, and the All Nodes | Best Nodes toggle", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("Energy Distribution");
    expect(text).toContain("Winning energies by type");
    // Old self-normalisation copy is gone.
    expect(text).not.toContain("normalised against itself");
    expect(text).toContain("All Nodes");
    expect(text).toContain("Best Nodes");
  });

  test("renders a single grouped chart when there are wins", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock({ minerId: "A" })],
      chainMiners: [makeChainMiner("A", "CPU")],
    });
    render();
    // One grouped chart, not three per-type panels.
    expect(container.querySelector('[data-qa="chart-energy-distribution"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="energy-distribution-CPU"]')).toBeNull();
  });

  test("renders the empty state when no type has any wins", () => {
    render();
    expect(container.querySelector('[data-qa="chart-energy-distribution"]')).toBeNull();
    expect(container.textContent).toContain("No wins yet");
  });

  test("switching to Best Nodes re-queries the hook without crashing", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xa1", minerId: "A", energy: -15_620 }),
        makeBlock({ blockHash: "0xb1", minerId: "B", energy: -15_400 }),
      ],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "CPU")],
    });
    render();
    const bestButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Best Nodes",
    )!;
    act(() => bestButton.click());
    expect(bestButton.getAttribute("aria-pressed")).toBe("true");
  });
});
