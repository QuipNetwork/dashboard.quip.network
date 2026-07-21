// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type { BlockRecord, NodeDescriptorRecord } from "@quip/shared/telemetry";

import { BlocksOverTimeCard } from "./BlocksOverTimeCard";

function block(overrides: Partial<BlockRecord> & Pick<BlockRecord, "minerId">): BlockRecord {
  return {
    blockHash: "0xblock",
    substrateBlockNumber: "1",
    substrateBlockHash: "0xsub",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    energy: -15000,
    diversity: 0.4,
    numValidSolutions: 1,
    miningTime: 5,
    deviceAccessTimeUs: null,
    reward: "0",
    qblockId: "1",
    nonce: "1",
    numNodes: 10,
    numEdges: 20,
    difficultyEnergy: -15000,
    minDiversity: 0.1,
    minSolutions: 1,
    finalized: true,
    topologyHash: null,
    ...overrides,
  };
}

function descriptorRecord(accountId: string, numCpus: number): NodeDescriptorRecord {
  return {
    accountId,
    blockNumber: "1",
    blockHash: "0xdesc",
    extrinsicIndex: 0,
    blockTimestamp: 0,
    firstBlockTimestamp: 0,
    observedAt: "2026-01-01T00:00:00Z",
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: accountId,
      miners: { [`${accountId}-cpu-1`]: { kind: "CPU", minerId: `${accountId}-cpu-1`, numCpus } },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({
    blocks: [
      block({ minerId: "5GCpu", timestamp: 1_700_000_000 }),
      block({ minerId: "5GCpu", timestamp: 1_700_000_060 }),
    ],
    chainMiners: [],
    nodeDescriptors: [descriptorRecord("5GCpu", 2)],
  });
  useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"], aggregationMode: "byType" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ blocks: [], chainMiners: [], nodeDescriptors: [] });
  useUIStore.setState({ aggregationMode: "byType" });
});

function render() {
  act(() => root.render(createElement(BlocksOverTimeCard)));
}

describe("BlocksOverTimeCard", () => {
  test("renders the title and the By Type | Normalized toggle", () => {
    render();
    expect(container.textContent).toContain("QBlocks Mined Over Time");
    const group = container.querySelector('[aria-label="QBlocks over time presentation"]');
    expect(group).not.toBeNull();
    const labels = Array.from(group?.querySelectorAll("button") ?? []).map((b) => b.textContent);
    expect(labels).toEqual(["By Type", "Normalized"]);
  });

  test("default 'By Type' preserves the existing cumulative series", () => {
    render();
    expect(container.querySelector('[data-qa="chart-blocks-over-time"]')).not.toBeNull();
    // CPU accumulates to 2 in By Type — no per-device division applied yet.
    expect(container.textContent).not.toContain("per registered device");
  });

  test("Normalized divides the CPU series by its registered device count (2)", () => {
    render();
    const [, normalizedButton] = Array.from(
      container.querySelectorAll('[aria-label="QBlocks over time presentation"] button'),
    );
    act(() => (normalizedButton as HTMLButtonElement | undefined)?.click());
    expect(container.textContent).toContain("per registered device");
  });

  test("hides the toggle when the global aggregation mode is byNode", () => {
    useUIStore.setState({ aggregationMode: "byNode" });
    render();
    expect(container.querySelector('[aria-label="QBlocks over time presentation"]')).toBeNull();
    expect(container.textContent).toContain("Cumulative qblocks per miner");
  });
});
