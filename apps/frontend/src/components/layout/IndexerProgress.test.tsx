// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { IndexerObservability } from "@quip/shared/telemetry";

import { IndexerProgress } from "./IndexerProgress";

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = new Date().toISOString();
  return {
    chainHeadFromNode: "559745",
    lastStatusFetchAt: now,
    lastBlockInsertAt: now,
    lastSubstrateEventAt: now,
    bestBlockHeight: "559745",
    finalizedBlockHeight: "559745",
    chainConnected: true,
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
  useTelemetryStore.setState({ indexer: null, serverTime: null });
});

describe("IndexerProgress", () => {
  test("renders indexing progress as current / total", () => {
    useTelemetryStore.setState({
      indexer: obs({
        indexer: { backfillQueueDepth: 4145, coverage: {}, difficultyDataStartBlock: null },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Indexing · 555,600 / 559,745");
  });

  test("renders nothing when live", () => {
    useTelemetryStore.setState({
      indexer: obs({
        indexer: { backfillQueueDepth: 0, coverage: {}, difficultyDataStartBlock: null },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toBe("");
  });

  test("renders node-sync progress as current / total", () => {
    useTelemetryStore.setState({
      indexer: obs({
        nodeSyncing: true,
        nodeSyncCurrentBlock: "559624",
        nodeSyncHighestBlock: "559745",
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Node sync · 559,624 / 559,745");
  });

  test("exposes the progress line as an accessible live region", () => {
    useTelemetryStore.setState({
      indexer: obs({
        nodeSyncing: true,
        nodeSyncCurrentBlock: "559624",
        nodeSyncHighestBlock: "559745",
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });
});
