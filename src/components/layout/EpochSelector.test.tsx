// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "../../store/telemetry-store";
import { useUIStore } from "../../store/ui-store";
import type { BlockRecord, IndexerObservability, TelemetryIndex } from "../../types/telemetry";

import { EpochSelector } from "./EpochSelector";

function makeBlock(epoch: string, blockIndex: number): BlockRecord {
  return {
    epoch,
    blockIndex,
    blockHash: `h-${epoch}-${blockIndex}`,
    timestamp: 1_700_000_000 + blockIndex,
    previousHash: `p-${blockIndex}`,
    minerId: "miner",
    minerCategory: "CPU",
    ecdsaPublicKey: "pk",
    energy: 0,
    diversity: 0,
    numValidSolutions: 0,
    miningTime: 0,
    nonce: "0",
    numNodes: 0,
    numEdges: 0,
    difficultyEnergy: 0,
    minDiversity: 0,
    minSolutions: 0,
    substrateBlockNumber: null,
    substrateBlockHash: null,
    substrateParentHash: null,
    extrinsicsRoot: null,
    stateRoot: null,
    finalized: false,
    isCanonical: true,
  };
}

function makeIndexer(latestEpoch: string): IndexerObservability {
  return {
    nodeLatestEpoch: latestEpoch,
    nodeLatestBlockIndex: 1,
    tipEpoch: latestEpoch,
    tipBlockIndex: 1,
    backfillEpoch: null,
    backfillBlockIndex: 0,
    lastStatusFetchAt: new Date().toISOString(),
    lastBlockInsertAt: new Date().toISOString(),
    nodesObservedAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: false,
  };
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
    indexer: null,
    telemetryIndex: null,
  });
  useUIStore.setState({ selectedEpoch: "all" });
});

describe("EpochSelector audit-fix #2 (status badging)", () => {
  test("badges only the currently-extending epoch as '(live)'", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock("aaaa1111", 1), makeBlock("bbbb2222", 1)],
      indexer: makeIndexer("bbbb2222"),
      telemetryIndex: null,
    });
    act(() => {
      root.render(createElement(EpochSelector));
    });
    const options = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
    const live = options.find((t) => t?.includes("bbbb2222"));
    const past = options.find((t) => t?.includes("aaaa1111"));
    expect(live).toContain("(live)");
    // Past canonical epochs do NOT get tagged "(stale)" — the old behavior
    // conflated history with stale forks (audit #2).
    expect(past).not.toContain("(stale");
  });

  test("badges actual stale_fork epochs from telemetryIndex", () => {
    const index: TelemetryIndex = {
      epochs: [
        { epoch: "aaaa1111", blockCount: 5, status: "stale_fork", firstBlockTimestamp: 1_700_000_001 },
        { epoch: "bbbb2222", blockCount: 1, status: "live", firstBlockTimestamp: 1_700_000_005 },
      ],
      lastUpdated: new Date().toISOString(),
    };
    useTelemetryStore.setState({
      blocks: [makeBlock("aaaa1111", 1), makeBlock("bbbb2222", 1)],
      indexer: makeIndexer("bbbb2222"),
      telemetryIndex: index,
    });
    act(() => {
      root.render(createElement(EpochSelector));
    });
    const options = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
    const fork = options.find((t) => t?.includes("aaaa1111"));
    const live = options.find((t) => t?.includes("bbbb2222"));
    expect(fork).toContain("(stale fork)");
    expect(live).toContain("(live)");
  });

  test("unlabeled when no live epoch and no stale_fork status (just history)", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock("aaaa1111", 1)],
      indexer: null,
      telemetryIndex: null,
    });
    act(() => {
      root.render(createElement(EpochSelector));
    });
    const options = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
    const opt = options.find((t) => t?.includes("aaaa1111"));
    expect(opt).not.toContain("(live)");
    expect(opt).not.toContain("(stale");
  });
});
