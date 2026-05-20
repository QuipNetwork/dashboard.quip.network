// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, IndexerObservability } from "../../../types/telemetry";

import { RecentBlocksTable } from "./RecentBlocksTable";

// Component tests cover two surfaces:
//   1. The chain-health banner the staleness library surfaces — wording is
//      load-bearing ("seen" not "produced", "hasn't polled" for a wedged
//      indexer). Reverting either is a regression.
//   2. Client-side pagination — the table renders 100 rows by default and
//      reveals 100 more per "Load more" click, capped at blocks.length.

function makeBlock(i: number, tsSec: number): BlockRecord {
  return {
    blockHash: `hash-${i}`,
    substrateBlockNumber: String(i),
    substrateBlockHash: `sub-hash-${i}`,
    substrateParentHash: `sub-parent-${i}`,
    timestamp: tsSec,
    minerId: `miner-${i}`,
    energy: -1,
    diversity: 0.5,
    numValidSolutions: 1,
    qualityMilli: 1000,
    miningTime: 1,
    reward: "1000000000000000000",
    nonce: "1",
    numNodes: 1,
    numEdges: 1,
    difficultyEnergy: -1,
    minDiversity: 0,
    minSolutions: 1,
    finalized: false,
  };
}

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = Date.now();
  return {
    chainHeadFromNode: null,
    lastStatusFetchAt: new Date(now - 10_000).toISOString(),
    lastBlockInsertAt: new Date(now - 10_000).toISOString(),
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: false,
    minerStats: null,
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

  // The two stale-tip banner cases (3h-old block) live in
  // src/lib/staleness.test.ts now — they exercise computeChainHealth, not
  // anything table-specific. The library still reads v0.2 cursor fields that
  // were removed from IndexerObservability in v0.3; Task 3.7 reinstates the
  // tip-age path. Keeping a table-level smoke test here would just couple us
  // to that bug fix without adding coverage.

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

describe("RecentBlocksTable columns", () => {
  test("renders substrateBlockNumber, not blockIndex, in the Block column", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(4242, nowSec - 30)];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));
    const blockCell = container.querySelector("tbody tr td");
    expect(blockCell?.textContent).toMatch(/#4242/);
  });

  test("renders a Reward column header and a formatted reward value", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(1, nowSec - 30)];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));
    const headers = Array.from(container.querySelectorAll("thead th")).map(
      (th) => th.textContent ?? "",
    );
    expect(headers).toContain("Reward");
    expect(headers).not.toContain("Epoch");
    expect(headers).not.toContain("Type");
  });
});

describe("RecentBlocksTable pagination", () => {
  function makeNBlocks(n: number): BlockRecord[] {
    const nowSec = Math.floor(Date.now() / 1000);
    // Newest first to mirror what useTelemetryStore ships (DESC by
    // substrate_block_number).
    return Array.from({ length: n }, (_, idx) => makeBlock(n - idx, nowSec - idx * 6));
  }

  function countDataRows(): number {
    return container.querySelectorAll("tbody tr").length;
  }

  function loadMoreButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>("button[data-testid='load-more']");
  }

  test("renders 100 rows by default and shows the Load more button when more remain", () => {
    render(createElement(RecentBlocksTable, { blocks: makeNBlocks(250), indexer: obs() }));
    expect(countDataRows()).toBe(100);
    expect(loadMoreButton()).not.toBeNull();
  });

  test("clicking Load more reveals 100 more rows until exhausted", () => {
    render(createElement(RecentBlocksTable, { blocks: makeNBlocks(250), indexer: obs() }));

    // First click: 100 → 200, button still present.
    act(() => {
      loadMoreButton()?.click();
    });
    expect(countDataRows()).toBe(200);
    expect(loadMoreButton()).not.toBeNull();

    // Second click: 200 → 250 (capped at blocks.length), button hidden.
    act(() => {
      loadMoreButton()?.click();
    });
    expect(countDataRows()).toBe(250);
    expect(loadMoreButton()).toBeNull();
  });

  test("hides Load more when block count is already at or below the page size", () => {
    render(createElement(RecentBlocksTable, { blocks: makeNBlocks(42), indexer: obs() }));
    expect(countDataRows()).toBe(42);
    expect(loadMoreButton()).toBeNull();
  });
});
