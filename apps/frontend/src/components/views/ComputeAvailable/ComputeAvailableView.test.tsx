// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import { ComputeAvailableView } from "./ComputeAvailableView";

// Render against the GLOBAL stores (the tests drive them via setState) but
// with a hanging client, so useMinerWins doesn't fire a real fetch.
function renderView(root: Root): void {
  act(() => {
    root.render(
      createElement(ServicesProvider, {
        client: idleTelemetryClient,
        children: createElement(ComputeAvailableView),
      }),
    );
  });
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
  useTelemetryStore.setState({
    blocks: [],
    chainMiners: [],
    recentDifficulty: [],
    nodes: null,
    serverTime: null,
  });
  useUIStore.setState({ aggregationMode: "byType" });
});

describe("ComputeAvailableView", () => {
  test("hosts the mining analytics: FLOPS tiles, qblock feed, leaderboard, charts", () => {
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).toContain("Last Block FLOPS");
    expect(text).toContain("Current Block FLOPS");
    expect(text).toContain("Current Difficulty");
    expect(text).toContain("Recent QBlocks");
    expect(text).toContain("Mining Leaderboard");
    expect(text).toContain("QBlocks Mined Over Time");
    expect(text).toContain("Difficulty over time");
  });

  test("hides the by-type-only charts in byNode mode", () => {
    useUIStore.setState({ aggregationMode: "byNode" });
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Mining Nodes by Type");
    expect(text).not.toContain("Win Rate by Difficulty");
  });
});
