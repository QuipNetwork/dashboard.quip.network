// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "../../store/telemetry-store";
import type { BlockRecord, IndexerObservability } from "../../types/telemetry";

import { SyncIndicator } from "./SyncIndicator";

// Helper to mint a block whose timestamp is usable for "recent tip".
function recentBlock(): BlockRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    epoch: "x",
    blockIndex: 10,
    blockHash: "h",
    timestamp: nowSec - 5,
    previousHash: "p",
    minerId: "m",
    minerCategory: "QPU",
    ecdsaPublicKey: "pk",
    energy: -1,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 1,
    nonce: "1",
    numNodes: 1,
    numEdges: 1,
    difficultyEnergy: -1,
    minDiversity: 0,
    minSolutions: 1,
    substrateBlockNumber: null,
    substrateBlockHash: null,
    substrateParentHash: null,
    extrinsicsRoot: null,
    stateRoot: null,
    finalized: false,
    isCanonical: true,
  };
}

function baseObs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = Date.now();
  return {
    nodeLatestEpoch: "x",
    nodeLatestBlockIndex: 10,
    tipEpoch: "x",
    tipBlockIndex: 10,
    backfillEpoch: null,
    backfillBlockIndex: 0,
    lastStatusFetchAt: new Date(now - 10_000).toISOString(),
    lastBlockInsertAt: new Date(now - 10_000).toISOString(),
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Reset the store to a known empty state. Preserve the fetchTelemetry
  // function reference so TelemetryState stays satisfied.
  useTelemetryStore.setState((s) => ({
    ...s,
    blocks: [],
    nodes: null,
    selfAddress: null,
    indexer: null,
    loading: false,
    error: null,
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui: ReturnType<typeof createElement>) {
  act(() => {
    root.render(ui);
  });
}

describe("SyncIndicator", () => {
  test("renders 'Connecting to node…' when indexer is null", () => {
    render(createElement(SyncIndicator));
    expect(container.textContent).toContain("Connecting to node…");
  });

  test("renders 'Live' when caught up", () => {
    useTelemetryStore.setState((s) => ({
      ...s,
      blocks: [recentBlock()],
      indexer: baseObs(),
    }));
    render(createElement(SyncIndicator));
    expect(container.textContent).toContain("Live");
  });

  test("renders 'Synchronizing · N blocks behind' when tip lags same epoch", () => {
    useTelemetryStore.setState((s) => ({
      ...s,
      blocks: [recentBlock()],
      indexer: baseObs({ nodeLatestBlockIndex: 25, tipBlockIndex: 18 }),
    }));
    render(createElement(SyncIndicator));
    expect(container.textContent).toMatch(/Synchronizing · 7 blocks behind/);
  });

  test("renders 'Catching up to new epoch' on epoch mismatch", () => {
    useTelemetryStore.setState((s) => ({
      ...s,
      blocks: [recentBlock()],
      indexer: baseObs({ nodeLatestEpoch: "Y", tipEpoch: "X" }),
    }));
    render(createElement(SyncIndicator));
    expect(container.textContent).toContain("Catching up to new epoch");
  });

  test("renders 'Backfilling history' when tip caught up and backfill active", () => {
    useTelemetryStore.setState((s) => ({
      ...s,
      blocks: [recentBlock()],
      indexer: baseObs({ backfillEpoch: "dead-fork", backfillBlockIndex: 3 }),
    }));
    render(createElement(SyncIndicator));
    expect(container.textContent).toContain("Backfilling history");
  });

  test("renders 'Indexer offline · Xm' when heartbeat is stale", () => {
    const oldHeartbeat = new Date(Date.now() - 7 * 60_000).toISOString();
    useTelemetryStore.setState((s) => ({
      ...s,
      blocks: [recentBlock()],
      indexer: baseObs({ lastStatusFetchAt: oldHeartbeat }),
    }));
    render(createElement(SyncIndicator));
    expect(container.textContent).toMatch(/Indexer offline · 7m/);
  });

  test("role='status' for accessibility", () => {
    render(createElement(SyncIndicator));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});
