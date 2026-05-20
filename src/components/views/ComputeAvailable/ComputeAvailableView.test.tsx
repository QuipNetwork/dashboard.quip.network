// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "../../../store/telemetry-store";
import type { ChainMinerRecord, MinerHardwareRecord } from "../../../types/telemetry";

import { ComputeAvailableView } from "./ComputeAvailableView";

function makeMiner(overrides: Partial<ChainMinerRecord> = {}): ChainMinerRecord {
  return {
    accountId: "5GAliceXxxxYyyyZzzz1234",
    deposit: "1000000000000",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
    ...overrides,
  };
}

function makeHardware(overrides: Partial<MinerHardwareRecord> = {}): MinerHardwareRecord {
  return {
    accountId: "5GAliceXxxxYyyyZzzz1234",
    nodeId: "test-node",
    miners: [{ id: "test-CPU-1", type: "CPU" }],
    primaryType: "CPU",
    source: "self",
    observedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
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
  useTelemetryStore.setState({
    chainMiners: [],
    recentDifficulty: [],
    serverTime: null,
  });
});

describe("ComputeAvailableView", () => {
  test("renders the Hardware Inventory section title", () => {
    useTelemetryStore.setState({ chainMiners: [], recentDifficulty: [], serverTime: null });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    expect(container.textContent).toContain("Hardware Inventory");
  });

  test("shows the empty state when no chain miners are registered", () => {
    useTelemetryStore.setState({ chainMiners: [], recentDifficulty: [], serverTime: null });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    expect(container.textContent).toContain("No on-chain miners registered yet.");
  });

  test("renders an account row with hardware text and 'this node' source for self", () => {
    useTelemetryStore.setState({
      chainMiners: [
        makeMiner({
          accountId: "5GAliceXxxxYyyyZzzz1234",
          telemetryNodeAddress: "test-node",
          hardware: makeHardware({ source: "self" }),
        }),
      ],
      recentDifficulty: [],
      serverTime: "2026-05-20T12:01:00.000Z",
    });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("CPU×1");
    expect(text).toContain("this node");
    expect(text).not.toContain("No on-chain miners registered yet.");
  });

  test("renders an Unknown italic row with 'peer-query pending' source when hardware is null", () => {
    useTelemetryStore.setState({
      chainMiners: [makeMiner({ accountId: "5GBobZzzz4321", hardware: null })],
      recentDifficulty: [],
      serverTime: "2026-05-20T12:01:00.000Z",
    });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Unknown");
    expect(text).toContain("peer-query pending");
    // The "—" placeholder fills the Last Seen column when hardware is absent.
    expect(text).toContain("—");
    // Verify the Unknown cell is rendered with italic styling.
    const unknownSpan = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "Unknown",
    );
    expect(unknownSpan).toBeDefined();
    expect(unknownSpan?.className).toContain("italic");
  });

  test("sorts miners with hardware before miners without hardware", () => {
    useTelemetryStore.setState({
      // Intentionally place the no-hardware row first in the source list so
      // the sort assertion proves the comparator (not insertion order)
      // controls the rendered order.
      chainMiners: [
        makeMiner({ accountId: "5GAA_no_hw", hardware: null }),
        makeMiner({
          accountId: "5GBB_has_hw",
          hardware: makeHardware({ accountId: "5GBB_has_hw" }),
        }),
      ],
      recentDifficulty: [],
      serverTime: "2026-05-20T12:01:00.000Z",
    });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    // The inventory table is the first <table> in the rendered output;
    // assert against its tbody only so the embedded chain-miners table
    // (which iterates the same array) doesn't confuse the assertion.
    const firstTable = container.querySelector("table");
    const rows = Array.from(firstTable?.querySelectorAll("tbody tr") ?? []);
    expect(rows.length).toBe(2);
    const firstRowText = rows[0]?.textContent ?? "";
    expect(firstRowText).toContain("5GBB_h");
    expect(firstRowText).not.toContain("5GAA_n");
  });
});
