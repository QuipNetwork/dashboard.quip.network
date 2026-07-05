// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord } from "@quip/shared/telemetry";
import { ServicesProvider } from "@/services/services-provider";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";

import { MyNodeView } from "./MyNodeView";

const SELF = "5GAlice";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: SELF,
    energy: -100,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    deviceAccessTimeUs: null,
    reward: "1000000000000",
    qblockId: "42",
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
    accountId: SELF,
    deposit: "1000000000000",
    proofsSubmitted: "12",
    proofsWon: "7",
    rewardsEarned: "7000000000000",
    telemetryNodeAddress: null,
    hardware: null,
    ...overrides,
  };
}

// Render against the GLOBAL stores (the tests drive them via setState) but
// with a hanging client, so useMinerWins doesn't fire a real fetch.
function renderView(root: Root): void {
  act(() => {
    root.render(
      createElement(ServicesProvider, {
        client: idleTelemetryClient,
        children: createElement(MyNodeView),
      }),
    );
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({
    blocks: [],
    selfAddress: null,
    chainMiners: [],
    recentDifficulty: [],
    indexer: null,
    serverTime: null,
  });
});

describe("MyNodeView", () => {
  test("shows the renamed Last Won QBlock Details pane, not the old title", () => {
    useTelemetryStore.setState({
      selfAddress: SELF,
      chainMiners: [makeChainMiner()],
      blocks: [makeBlock()],
    });
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).toContain("Last Won QBlock Details");
    expect(text).not.toContain("Last QBlock Details");
  });

  test("still renders QBlocks Won and Rewards Earned tiles", () => {
    useTelemetryStore.setState({
      selfAddress: SELF,
      chainMiners: [makeChainMiner()],
      blocks: [makeBlock()],
    });
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).toContain("QBlocks Won");
    expect(text).toContain("Rewards Earned");
  });
});
