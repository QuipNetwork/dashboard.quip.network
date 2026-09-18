// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { indexedDbNodeSummaryCache, type NodeSummaryCache } from "@/services/node-summary-cache";
import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { createTestServices, idleTelemetryClient } from "@/testing/services";
import type { NodeSummaryResponse } from "@quip/shared/telemetry";

import { useNodeSummary, type NodeSummaryState } from "./use-node-summary";

const summary = (lastWonQblockId: string): NodeSummaryResponse => ({
  summary: {
    minerId: "5A",
    wins: 28,
    bestEnergy: -14.5,
    avgMiningTime: 10,
    lastWonAt: 1_700_000_000,
    lastWonQblockId,
    lastWonBlockHash: `0x${lastWonQblockId}`,
  },
  lastWonBlock: null,
});

// A cache held in memory, recording writes.
function memoryCache(initial: NodeSummaryResponse | null): NodeSummaryCache & {
  writes: [string, NodeSummaryResponse][];
} {
  const writes: [string, NodeSummaryResponse][] = [];
  return {
    writes,
    read: async () => initial,
    write: async (accountId, value) => {
      writes.push([accountId, value]);
    },
  };
}

function clientFor(
  fetchNodeSummary: TelemetryClient["fetchNodeSummary"],
): TelemetryClient & { accounts: string[] } {
  const accounts: string[] = [];
  return {
    ...idleTelemetryClient,
    accounts,
    fetchNodeSummary: (accountId, signal) => {
      accounts.push(accountId);
      return fetchNodeSummary(accountId, signal);
    },
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

function renderHook(
  client: TelemetryClient,
  accountId: string | null,
  cache: NodeSummaryCache,
): { current: NodeSummaryState } {
  const result = { current: {} as NodeSummaryState };
  function Probe(): null {
    result.current = useNodeSummary(accountId, cache);
    return null;
  }
  const services = createTestServices({ client });
  act(() => {
    root.render(createElement(ServicesProvider, { ...services, children: createElement(Probe) }));
  });
  return result;
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useNodeSummary", () => {
  test("fetches the account's summary on open and caches the answer", async () => {
    const cache = memoryCache(null);
    const client = clientFor(async () => summary("1462"));
    const result = renderHook(client, "5A", cache);
    expect(result.current.loading).toBe(true);
    await flush();
    expect(client.accounts).toEqual(["5A"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.summary?.lastWonQblockId).toBe("1462");
    expect(cache.writes).toEqual([["5A", summary("1462")]]);
  });

  test("shows the cached summary while the backend answer is pending", async () => {
    const result = renderHook(
      clientFor(() => new Promise<never>(() => {})),
      "5A",
      memoryCache(summary("7")),
    );
    await flush();
    expect(result.current.loading).toBe(true);
    expect(result.current.summary?.lastWonQblockId).toBe("7");
  });

  test("a cached value never replaces a fresher backend answer", async () => {
    const cache: NodeSummaryCache = {
      read: () => new Promise((resolve) => setTimeout(() => resolve(summary("7")), 5)),
      write: async () => {},
    };
    const result = renderHook(
      clientFor(async () => summary("9")),
      "5A",
      cache,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.summary?.lastWonQblockId).toBe("9");
  });

  test("keeps the cached summary and reports the error when the fetch fails", async () => {
    const result = renderHook(
      clientFor(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("HTTP 503");
      }),
      "5A",
      memoryCache(summary("7")),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("HTTP 503");
    expect(result.current.summary?.lastWonQblockId).toBe("7");
  });

  test("does nothing without an account", async () => {
    const client = clientFor(async () => summary("1"));
    const result = renderHook(client, null, memoryCache(null));
    await flush();
    expect(client.accounts).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.summary).toBeNull();
  });
});

describe("indexedDbNodeSummaryCache", () => {
  test("reads nothing and writes without error when IndexedDB is absent", async () => {
    expect(typeof indexedDB).toBe("undefined");
    await indexedDbNodeSummaryCache.write("5A", summary("1"));
    expect(await indexedDbNodeSummaryCache.read("5A")).toBeNull();
  });
});
