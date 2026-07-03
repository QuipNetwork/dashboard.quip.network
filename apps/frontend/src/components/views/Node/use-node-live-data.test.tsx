// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NodeLiveData } from "@quip/shared/telemetry";
import { TelemetryClientContext, type TelemetryClient } from "@/services/telemetry-client";
import { useTelemetryStore } from "@/store/telemetry-store";

import { useNodeLiveData, type NodeLiveState } from "./use-node-live-data";

function reachable(accountId: string): NodeLiveData {
  return {
    accountId,
    reachable: true,
    minerStats: {
      headsObserved: 1,
      contextsDispatched: 1,
      resultsReceived: 1,
      proofsSubmitted: 3,
      staleDrops: 0,
      submissionErrors: 0,
      duplicateResultDrops: 0,
    },
    modes: {},
    currentDispatch: null,
    fetchedAt: "2026-06-30T00:00:00Z",
  };
}

function clientReturning(impl: TelemetryClient["fetchNodeLive"]): TelemetryClient {
  return {
    fetchTelemetry: () => new Promise<never>(() => {}),
    fetchMiningAttempts: () => new Promise<never>(() => {}),
    fetchBlocks: () => new Promise<never>(() => {}),
    fetchNodeLive: impl,
    fetchDifficultyHistory: () => new Promise<never>(() => {}),
    fetchMinerWins: () => new Promise<never>(() => {}),
  };
}

function renderHook(accountId: string, client: TelemetryClient): { current: NodeLiveState } {
  const result = { current: { status: "loading", data: null } as NodeLiveState };
  function Probe(): null {
    result.current = useNodeLiveData(accountId);
    return null;
  }
  act(() => {
    root.render(
      createElement(TelemetryClientContext.Provider, { value: client }, createElement(Probe)),
    );
  });
  return result;
}

const flush = () => act(async () => await Promise.resolve());

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ chainHead: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useNodeLiveData", () => {
  test("starts loading, then reports ok when the peer is reachable", async () => {
    const client = clientReturning(async (id) => reachable(id));
    const handle = renderHook("5GPeer", client);
    expect(handle.current.status).toBe("loading");
    await flush();
    expect(handle.current.status).toBe("ok");
    expect(handle.current.data?.minerStats?.proofsSubmitted).toBe(3);
  });

  test("reports unreachable when the proxy says reachable:false", async () => {
    const client = clientReturning(async (id) => ({ ...reachable(id), reachable: false }));
    const handle = renderHook("5GPeer", client);
    await flush();
    expect(handle.current.status).toBe("unreachable");
  });

  test("reports unreachable when the request throws", async () => {
    const client = clientReturning(async () => {
      throw new Error("network down");
    });
    const handle = renderHook("5GPeer", client);
    await flush();
    expect(handle.current.status).toBe("unreachable");
  });
});
