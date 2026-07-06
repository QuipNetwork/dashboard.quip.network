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
    expect(text).toContain("Last QBlock Details");
    expect(text).toContain("Current QBlock Details");
    expect(text).toContain("Historical QBlocks");
    expect(text).toContain("Mining Leaderboard");
    expect(text).toContain("QBlocks Mined Over Time");
    expect(text).toContain("Energy Distribution");
    expect(text).toContain("Time to QBlock");
    expect(text).toContain("Difficulty over time");
  });

  test("no longer hosts the node-inventory charts — they moved to Network (bead 1o0.1)", () => {
    // Total Compute Used and Mining Nodes by Type are node-inventory views;
    // they now live in the Network tab above On-chain miners. byType is the
    // default (afterEach resets it), the mode where both were visible here.
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Total Compute Used");
    expect(text).not.toContain("Mining Nodes by Type");
  });

  test("merges difficulty rows into Current QBlock Details, no standalone tile", () => {
    useTelemetryStore.setState({
      recentDifficulty: [
        {
          observedAtBlock: "100",
          difficultyEnergy: -120,
          minDiversity: 0.2,
          minSolutions: 2,
          observedAt: "2026-01-01T00:00:00.000Z",
          topologyHash: null,
          source: "poll",
        },
      ],
    });
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Current Difficulty");
    expect(text).toContain("Target Energy");
    expect(text).toContain("Min Diversity");
    expect(text).toContain("Min Solutions");
  });

  // Full width = the chart card is a page-level sibling, not a grid cell
  // (docs/ui-layout.md). No ancestor may be the 2-column chart grid.
  function expectFullWidth(selector: string, title: string): void {
    const heading = [...container.querySelectorAll(selector)].find((h) => h.textContent === title);
    expect(heading).toBeDefined();
    for (let el = heading!.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toContain("lg:grid-cols-2");
    }
  }

  test("renders Difficulty over time full width, outside the 2-column chart grid", () => {
    renderView(root);
    expectFullWidth("h3", "Difficulty over time");
  });

  test("Mining per QBlock offers range and grouping toggles", () => {
    renderView(root);
    // Windowing like the difficulty panel (1H…ALL), plus the card-local
    // All | By Type aggregation toggle (docs/ui-layout.md item 5).
    expect(
      container.querySelector('[role="group"][aria-label="Mining time range"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[role="group"][aria-label="Mining time grouping"]'),
    ).not.toBeNull();
  });

  test("hides the by-type-only charts in byNode mode", () => {
    useUIStore.setState({ aggregationMode: "byNode" });
    renderView(root);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Win Rate by Difficulty");
  });
});
