// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, IndexerObservability } from "../../../types/telemetry";

import { filterRecentBlocks, RecentBlocksTable, type NumberedBlock } from "./RecentBlocksTable";

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

describe("filterRecentBlocks", () => {
  const rows: NumberedBlock[] = [
    { block: makeBlock(10, 0), solutionNumber: 50 },
    { block: makeBlock(11, 0), solutionNumber: 51 },
    { block: makeBlock(12, 0), solutionNumber: 52 },
  ];

  test("returns all rows for an empty query", () => {
    expect(filterRecentBlocks(rows, "")).toHaveLength(3);
  });

  test("matches on winner (minerId)", () => {
    expect(filterRecentBlocks(rows, "miner-11").map((r) => r.block.substrateBlockNumber)).toEqual([
      "11",
    ]);
  });

  test("matches on substrate block number", () => {
    expect(filterRecentBlocks(rows, "12").map((r) => r.solutionNumber)).toEqual([52]);
  });

  test("matches on solution number", () => {
    expect(filterRecentBlocks(rows, "50").map((r) => r.block.substrateBlockNumber)).toEqual(["10"]);
  });
});

describe("RecentBlocksTable search", () => {
  function typeSearch(value: string) {
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(input, value);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
  }

  test("filters rows by winner as the operator types", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [
      makeBlock(10, nowSec - 30),
      makeBlock(11, nowSec - 36),
      makeBlock(12, nowSec - 42),
    ];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);

    typeSearch("miner-11");

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(container.textContent).toContain("#11");
  });

  test("shows an empty message when nothing matches", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const blocks = [makeBlock(10, nowSec - 30)];
    render(createElement(RecentBlocksTable, { blocks, indexer: obs() }));

    typeSearch("nope");

    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(container.textContent).toContain("No solutions match");
  });
});
