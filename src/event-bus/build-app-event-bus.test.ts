// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { TelemetryClient } from "../services/telemetry-client";
import { createTelemetryStore } from "../store/telemetry-store";
import type { MiningAttemptsResponse, TelemetryResponse } from "../types/telemetry";
import { buildAppEventBus } from "./build-app-event-bus";
import { FetchTelemetry } from "./fetch-telemetry";

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
  };
  return client;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("buildAppEventBus", () => {
  it("runs the telemetry fetch when a FetchTelemetry event is dispatched", async () => {
    const client = fakeClient();
    const store = createTelemetryStore({ client });
    const bus = buildAppEventBus({ telemetryStore: store }).start();

    bus.dispatch(new FetchTelemetry());
    await flush();

    expect(client.calls).toBe(1);
    expect(store.getState().selfAddress).toBe("5GPP");
    bus.stop();
  });

  it("drops events dispatched before start (hot subject, no replay)", async () => {
    const client = fakeClient();
    const store = createTelemetryStore({ client });
    const bus = buildAppEventBus({ telemetryStore: store });

    bus.dispatch(new FetchTelemetry());
    await flush();

    expect(client.calls).toBe(0);
  });
});
