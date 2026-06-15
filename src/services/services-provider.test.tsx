// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createTelemetryStore, telemetryStore, useTelemetryStore } from "../store/telemetry-store";
import { createUIStore, useUIStore } from "../store/ui-store";
import type { MiningAttemptsResponse, TelemetryResponse } from "../types/telemetry";
import { ServicesProvider } from "./services-provider";
import type { TelemetryClient } from "./telemetry-client";

const idleClient: TelemetryClient = {
  fetchTelemetry: async (): Promise<TelemetryResponse> => {
    throw new Error("not used");
  },
  fetchMiningAttempts: async (): Promise<MiningAttemptsResponse> => {
    throw new Error("not used");
  },
};

function SelfAddress() {
  const selfAddress = useTelemetryStore((s) => s.selfAddress);
  return createElement("span", null, selfAddress ?? "none");
}

function ViewMode() {
  const viewMode = useUIStore((s) => s.viewMode);
  return createElement("span", null, viewMode);
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

describe("ServicesProvider", () => {
  it("makes components read the injected store, not the singleton", () => {
    telemetryStore.setState({ selfAddress: "5Singleton" });
    const injected = createTelemetryStore({ client: idleClient });
    injected.setState({ selfAddress: "5Injected" });

    act(() => {
      root.render(
        <ServicesProvider telemetryStore={injected}>
          <SelfAddress />
        </ServicesProvider>,
      );
    });

    expect(container.textContent).toBe("5Injected");
  });

  it("falls back to the singleton when no store is injected", () => {
    telemetryStore.setState({ selfAddress: "5Default" });

    act(() => {
      root.render(
        <ServicesProvider>
          <SelfAddress />
        </ServicesProvider>,
      );
    });

    expect(container.textContent).toBe("5Default");
  });

  it("injects the UI store independently of the singleton", () => {
    const injected = createUIStore();
    injected.setState({ viewMode: "chain" });

    act(() => {
      root.render(
        <ServicesProvider uiStore={injected}>
          <ViewMode />
        </ServicesProvider>,
      );
    });

    expect(container.textContent).toBe("chain");
  });
});
