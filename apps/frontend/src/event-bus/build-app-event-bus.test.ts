// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { TelemetryClient } from "@/services/telemetry-client";
import { createTelemetryStore } from "@/store/telemetry-store";
import { createUIStore } from "@/store/ui-store";
import type { MiningAttemptsResponse, TelemetryResponse } from "@quip/shared/telemetry";
import { buildAppEventBus } from "./build-app-event-bus";
import { FetchTelemetry } from "./fetch-telemetry";
import { SetViewMode, ToggleMinerType } from "./ui-actions";

interface FakeClient extends TelemetryClient {
  calls: number;
}

function fakeClient(response: Partial<TelemetryResponse> = {}): FakeClient {
  const client: FakeClient = {
    calls: 0,
    fetchTelemetry: async () => {
      client.calls += 1;
      return { blocks: [], selfAddress: "5GPP", ...response } as TelemetryResponse;
    },
    fetchMiningAttempts: async (): Promise<MiningAttemptsResponse> => {
      throw new Error("not used");
    },
    fetchBlocks: async () => [],
    fetchNodeLive: () => new Promise<never>(() => {}),
    fetchDifficultyHistory: () => new Promise<never>(() => {}),
    fetchMinerWins: () => new Promise<never>(() => {}),
  };
  return client;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("buildAppEventBus", () => {
  it("runs the telemetry fetch when a FetchTelemetry event is dispatched", async () => {
    const client = fakeClient();
    const store = createTelemetryStore({ client });
    const bus = buildAppEventBus({ telemetryStore: store, uiStore: createUIStore() }).start();

    bus.dispatch(new FetchTelemetry());
    await flush();

    expect(client.calls).toBe(1);
    expect(store.getState().selfAddress).toBe("5GPP");
    bus.stop();
  });

  it("drops events dispatched before start (hot subject, no replay)", async () => {
    const client = fakeClient();
    const store = createTelemetryStore({ client });
    const bus = buildAppEventBus({ telemetryStore: store, uiStore: createUIStore() });

    bus.dispatch(new FetchTelemetry());
    await flush();

    expect(client.calls).toBe(0);
  });

  it("applies UI actions to the ui store", () => {
    const telemetryStore = createTelemetryStore({ client: fakeClient() });
    const uiStore = createUIStore();
    const bus = buildAppEventBus({ telemetryStore, uiStore }).start();

    bus.dispatch(new SetViewMode("chain"));
    expect(uiStore.getState().viewMode).toBe("chain");

    bus.dispatch(new ToggleMinerType("CPU"));
    expect(uiStore.getState().selectedTypes).not.toContain("CPU");

    bus.stop();
  });
});
