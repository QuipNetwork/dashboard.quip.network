// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, IndexerObservability } from "../../../types/telemetry";

import { RecentBlocksTable } from "./RecentBlocksTable";

// Component tests focus on the banner that the staleness library surfaces —
// specifically the observational wording ("seen" not "produced") and the
// color semantics. The table cells themselves are trivial and covered
// transitively by the app smoke test.

function makeBlock(i: number, tsSec: number): BlockRecord {
  return {
    epoch: "1700000000",
    blockIndex: i,
    blockHash: `hash-${i}`,
    timestamp: tsSec,
    previousHash: `prev-${i}`,
    minerId: `miner-${i}`,
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
  };
}

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = Date.now();
  return {
    nodeLatestEpoch: "1700000000",
    nodeLatestBlockIndex: 10,
    tipEpoch: "1700000000",
    tipBlockIndex: 10,
    backfillEpoch: null,
    backfillBlockIndex: 0,
    lastStatusFetchAt: new Date(now - 10_000).toISOString(),
    lastBlockInsertAt: new Date(now - 10_000).toISOString(),
    ...overrides,
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
});

function render(ui: ReturnType<typeof createElement>) {
  act(() => {
    root.render(ui);
  });
}

describe("RecentBlocksTable banner", () => {
  test("renders no banner when the tip is recent and indexer is caught up", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(10, nowSec - 30)];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("renders a stalled banner in red when the tip is 3h old", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(10, nowSec - 3 * 60 * 60)];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));
    const banner = container.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner?.className).toMatch(/red-500/);
  });

  test("uses observational 'seen' wording, not 'produced', for a stalled chain", () => {
    // Load-bearing: the dashboard only knows what the node reports, so the
    // copy must not claim the node failed to *produce* a block — only that
    // no new block has been *seen*. Reverting this wording is a regression.
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(10, nowSec - 3 * 60 * 60)];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));
    const banner = container.querySelector('[role="status"]');
    expect(banner?.textContent).toMatch(/hasn't seen/);
    expect(banner?.textContent).not.toMatch(/produced/);
  });

  test("renders 'indexer is N blocks behind' when the indexer is lagging the node", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(10, nowSec - 30)];
    const indexer = obs({ nodeLatestBlockIndex: 15, tipBlockIndex: 10 });
    render(createElement(RecentBlocksTable, { blocks, indexer }));
    const banner = container.querySelector('[role="status"]');
    expect(banner?.textContent).toMatch(/Indexer is 5 blocks behind/);
  });

  test("renders 'indexer hasn't polled' when the heartbeat is stale", () => {
    // The whole point of lastStatusFetchAt — surface a wedged indexer so the
    // operator doesn't chase a non-existent node-side bug.
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(10, nowSec - 30)];
    const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    render(
      createElement(RecentBlocksTable, {
        blocks,
        indexer: obs({ lastStatusFetchAt: staleHeartbeat }),
      }),
    );
    const banner = container.querySelector('[role="status"]');
    expect(banner?.className).toMatch(/red-500/);
    expect(banner?.textContent).toMatch(/indexer hasn't polled/);
  });
});
