// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SyncIndicator } from "../components/layout/SyncIndicator";
import { createTestServices, StoryServices } from "./services";

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

describe("createTestServices", () => {
  it("seeds the telemetry and UI stores from overrides", () => {
    const { telemetryStore, uiStore, eventBus } = createTestServices({
      telemetry: { selfAddress: "5GPP" },
      ui: { viewMode: "chain" },
    });

    expect(telemetryStore.getState().selfAddress).toBe("5GPP");
    expect(uiStore.getState().viewMode).toBe("chain");
    expect(eventBus).toBeDefined();
  });

  it("leaves stores at their defaults when no overrides are given", () => {
    const { telemetryStore, uiStore } = createTestServices();

    expect(telemetryStore.getState().selfAddress).toBeNull();
    expect(uiStore.getState().viewMode).toBe("my-node");
  });
});

describe("StoryServices", () => {
  it("renders a store-consuming component against injected state", () => {
    act(() => {
      root.render(
        <StoryServices telemetry={{ loading: false, indexer: null }}>
          <SyncIndicator />
        </StoryServices>,
      );
    });

    expect(container.textContent).toContain("Connecting to miner…");
  });
});
