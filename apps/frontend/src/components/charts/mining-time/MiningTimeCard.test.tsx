// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Mining per QBlock" card chrome: the renamed title, the three-way
// grouping toggle (All | By Type | Normalized), the Time | Energy metric
// toggle, and the winner-honest subtitle (the indexer records winners only,
// so the card never claims all-participant sums).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import { MiningTimeCard } from "./MiningTimeCard";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ blocks: [], nodes: null, chainMiners: [], nodeDescriptors: [] });
  useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderCard(): void {
  act(() => {
    root.render(
      createElement(ServicesProvider, {
        client: idleTelemetryClient,
        children: createElement(MiningTimeCard),
      }),
    );
  });
}

function groupButtons(ariaLabel: string): string[] {
  const group = container.querySelector(`[role="group"][aria-label="${ariaLabel}"]`);
  expect(group).not.toBeNull();
  return Array.from(group!.querySelectorAll("button")).map((b) => b.textContent ?? "");
}

function clickButton(ariaLabel: string, label: string): void {
  const group = container.querySelector(`[role="group"][aria-label="${ariaLabel}"]`)!;
  const button = Array.from(group.querySelectorAll("button")).find((b) => b.textContent === label)!;
  act(() => button.click());
}

describe("MiningTimeCard", () => {
  test("renders the renamed title", () => {
    renderCard();
    expect(container.textContent).toContain("Mining per QBlock");
    expect(container.textContent).not.toContain("Mining Time per QBlock");
  });

  test("offers grouping (incl. Normalized), metric, and range toggles", () => {
    renderCard();
    expect(groupButtons("Mining time grouping")).toEqual(["All", "By Type", "Normalized"]);
    expect(groupButtons("Mining metric")).toEqual(["Time", "Energy"]);
    expect(groupButtons("Mining time range").length).toBeGreaterThan(0);
  });

  test("subtitle stays winner-honest and follows the toggles", () => {
    renderCard();
    expect(container.textContent).toContain("Winner's device time per qblock by processor type");

    clickButton("Mining metric", "Energy");
    expect(container.textContent).toContain("Winner's device energy per qblock by processor type");

    clickButton("Mining time grouping", "Normalized");
    expect(container.textContent).toContain(
      "Share of winner device energy at the reference composition",
    );
  });
});
