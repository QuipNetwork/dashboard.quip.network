// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { sampleTelemetry } from "@/testing/sample-telemetry";
import { StoryServices } from "@/testing/services";
import type { ViewMode } from "@/store/ui-store";
import { waitFor } from "@/test/wait-for-act";
import { Dashboard } from "./Dashboard";

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

async function renderDashboard(viewMode: ViewMode) {
  act(() => {
    root.render(
      <StoryServices telemetry={sampleTelemetry()} ui={{ viewMode }}>
        <Dashboard />
      </StoryServices>,
    );
  });
  if (viewMode === "network") {
    await waitFor(() => (container.textContent ?? "").includes("Node Locations"));
  }
  if (viewMode === "compute") {
    await waitFor(() => container.querySelector('[data-qa="chart-blocks-over-time"]') !== null);
  }
}

describe("Dashboard page with sample telemetry", () => {
  it("renders the My Node view populated", async () => {
    await renderDashboard("my-node");
    expect(container.textContent).toContain("Connected Miner");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("renders the Network view populated", async () => {
    await renderDashboard("network");
    expect(container.textContent).toContain("Node Locations");
    expect(container.textContent).toContain("On-chain miners");
    expect(container.textContent).toContain("QPU");
  });

  it("renders the Compute view populated", async () => {
    await renderDashboard("compute");
    expect(container.querySelector('[data-qa="chart-blocks-over-time"]')).not.toBeNull();
    expect(container.textContent).toContain("Mining Leaderboard");
    expect(container.textContent).toContain("Historical QBlocks");
  });

  it("renders the Chain view populated", async () => {
    await renderDashboard("chain");
    expect(container.textContent).toContain("validator-alpha");
  });

  it("shows the loading state", () => {
    act(() => {
      root.render(
        <StoryServices telemetry={{ loading: true }}>
          <Dashboard />
        </StoryServices>,
      );
    });
    expect(container.textContent).toContain("Loading telemetry…");
  });

  it("shows the error state", () => {
    act(() => {
      root.render(
        <StoryServices telemetry={{ loading: false, error: "boom" }}>
          <Dashboard />
        </StoryServices>,
      );
    });
    expect(container.textContent).toContain("boom");
  });
});
