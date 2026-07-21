// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type { BlockRecord } from "@quip/shared/telemetry";

import { TimeToSolutionCard } from "./TimeToSolutionCard";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GCpu",
    energy: -14_500,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -14_500,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: false,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({
    blocks: [makeBlock()],
    chainMiners: [],
    nodeDescriptors: [],
  });
  useUIStore.setState({ aggregationMode: "byType", selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TimeToSolutionCard", () => {
  test("renders the title and both node-scope toggle options", () => {
    act(() => root.render(createElement(TimeToSolutionCard)));

    expect(container.textContent).toContain("Time to QBlock");
    expect(container.textContent).toContain("All Nodes");
    expect(container.textContent).toContain("Best Nodes");
  });
});
