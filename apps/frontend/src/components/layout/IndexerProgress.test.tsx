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

// Backfill-progress object whose summed coverage gapBlocks equals `gap`.
const cov = (gap: number): NonNullable<IndexerObservability["indexer"]> => ({
  backfillQueueDepth: 0,
  difficultyDataStartBlock: null,
  coverage: {
    winners: {
      low: "0",
      high: "560000",
      gapBlocks: gap,
      prunedFloor: null,
      topologyEnrichmentFloor: null,
      generation: 1,
    },
  },
});

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
        indexer: {
          backfillQueueDepth: 0,
          difficultyDataStartBlock: null,
          coverage: {
            winners: {
              low: "394362",
              high: "559745",
              gapBlocks: 4145,
              prunedFloor: null,
              topologyEnrichmentFloor: null,
              generation: 1,
            },
          },
        },
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

  test("appends the server ETA when backfillEtaSeconds is set", () => {
    useTelemetryStore.setState({
      indexer: obs({
        chainHeadFromNode: "560000",
        indexer: { ...cov(12_000), backfillEtaSeconds: 780 },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Indexing · 548,000 / 560,000 · ~13m");
  });

  test("omits the ETA when backfillEtaSeconds is null", () => {
    useTelemetryStore.setState({
      indexer: obs({
        chainHeadFromNode: "560000",
        indexer: { ...cov(12_000), backfillEtaSeconds: null },
      }),
      serverTime: null,
    });
    act(() => root.render(createElement(IndexerProgress)));
    expect(container.textContent).toContain("Indexing · 548,000 / 560,000");
    expect(container.textContent).not.toMatch(/~\d/);
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
