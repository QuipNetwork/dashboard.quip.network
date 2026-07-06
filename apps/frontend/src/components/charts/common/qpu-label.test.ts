// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { NodeDescriptorRecord, NodeMinerEntry } from "@quip/shared/telemetry";

import { QPU_DAILY_BUDGET_MIN } from "./normalized-composition";
import {
  displayLabelForCategory,
  latestAdvertisedQpuBudgetMin,
  qpuDisplayLabel,
  useQpuDisplayLabel,
} from "./qpu-label";

function descriptor(
  accountId: string,
  blockTimestamp: number,
  miners: Record<string, NodeMinerEntry>,
): NodeDescriptorRecord {
  return {
    accountId,
    blockNumber: String(blockTimestamp),
    blockHash: `0x${accountId}`,
    extrinsicIndex: 0,
    blockTimestamp,
    firstBlockTimestamp: blockTimestamp,
    observedAt: new Date(blockTimestamp * 1000).toISOString(),
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: accountId,
      miners,
    },
  };
}

function qpuEntry(dailyBudget?: string): NodeMinerEntry {
  return { kind: "QPU", minerId: "qpu-1", dailyBudget };
}

describe("qpuDisplayLabel", () => {
  test('returns plain "QPU" in standard mode (the default), regardless of budget', () => {
    expect(qpuDisplayLabel()).toBe("QPU");
    expect(qpuDisplayLabel(45)).toBe("QPU");
    expect(qpuDisplayLabel(45, "standard")).toBe("QPU");
  });

  test('returns "QPU20m" in normalized mode with no budget, derived from QPU_DAILY_BUDGET_MIN', () => {
    expect(qpuDisplayLabel(undefined, "normalized")).toBe("QPU20m");
    expect(qpuDisplayLabel(undefined, "normalized")).toBe(`QPU${QPU_DAILY_BUDGET_MIN}m`);
  });

  test("uses a provided finite positive budget in normalized mode", () => {
    expect(qpuDisplayLabel(45, "normalized")).toBe("QPU45m");
  });

  test("falls back to QPU_DAILY_BUDGET_MIN in normalized mode for null/undefined/non-positive", () => {
    expect(qpuDisplayLabel(null, "normalized")).toBe("QPU20m");
    expect(qpuDisplayLabel(undefined, "normalized")).toBe("QPU20m");
    expect(qpuDisplayLabel(0, "normalized")).toBe("QPU20m");
    expect(qpuDisplayLabel(-5, "normalized")).toBe("QPU20m");
    expect(qpuDisplayLabel(Number.NaN, "normalized")).toBe("QPU20m");
  });
});

describe("displayLabelForCategory", () => {
  test('relabels QPU to plain "QPU" in standard mode (the default)', () => {
    expect(displayLabelForCategory("QPU")).toBe("QPU");
    expect(displayLabelForCategory("QPU", "standard")).toBe("QPU");
  });

  test("relabels QPU to the budget-qualified display label in normalized mode", () => {
    expect(displayLabelForCategory("QPU", "normalized")).toBe("QPU20m");
  });

  test("passes every other id through unchanged in either mode", () => {
    for (const id of ["CPU", "GPU", "OTHER", "All", "QPUWC", "5abc123"]) {
      expect(displayLabelForCategory(id)).toBe(id);
      expect(displayLabelForCategory(id, "normalized")).toBe(id);
    }
  });
});

describe("latestAdvertisedQpuBudgetMin", () => {
  test.each([
    ["20", 20],
    ["20m", 20],
    ["20min", 20],
    ["45m", 45],
    ["45.5m", 45.5],
  ] as const)("parses %s to %d", (raw, expected) => {
    const budget = latestAdvertisedQpuBudgetMin([descriptor("a", 100, { qpu: qpuEntry(raw) })]);
    expect(budget).toBe(expected);
  });

  test.each([
    ["garbage", undefined],
    ["", undefined],
    ["-5m", undefined],
    ["0", undefined],
    ["20 hours", undefined],
  ] as const)("returns null for unparseable %s", (raw) => {
    const budget = latestAdvertisedQpuBudgetMin([descriptor("a", 100, { qpu: qpuEntry(raw) })]);
    expect(budget).toBeNull();
  });

  test("returns null when the dailyBudget field is absent", () => {
    const budget = latestAdvertisedQpuBudgetMin([descriptor("a", 100, { qpu: qpuEntry() })]);
    expect(budget).toBeNull();
  });

  test("returns null with no descriptors", () => {
    expect(latestAdvertisedQpuBudgetMin([])).toBeNull();
  });

  test("ignores non-QPU entries", () => {
    const budget = latestAdvertisedQpuBudgetMin([
      descriptor("a", 100, { cpu: { kind: "CPU", minerId: "cpu-1" } }),
    ]);
    expect(budget).toBeNull();
  });

  test("picks the most recently updated descriptor's value", () => {
    const budget = latestAdvertisedQpuBudgetMin([
      descriptor("old", 100, { qpu: qpuEntry("20m") }),
      descriptor("new", 200, { qpu: qpuEntry("45m") }),
    ]);
    expect(budget).toBe(45);
  });

  test("falls back to an older valid value when the newest one doesn't parse", () => {
    const budget = latestAdvertisedQpuBudgetMin([
      descriptor("old", 100, { qpu: qpuEntry("20m") }),
      descriptor("new", 200, { qpu: qpuEntry("garbage") }),
    ]);
    expect(budget).toBe(20);
  });
});

describe("useQpuDisplayLabel", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Label({ mode }: { mode?: "standard" | "normalized" }) {
    return createElement("span", null, useQpuDisplayLabel(mode));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useTelemetryStore.setState({ nodeDescriptors: [] });
  });

  test('renders plain "QPU" in standard mode (the default), even with a budget advertised', () => {
    useTelemetryStore.setState({
      nodeDescriptors: [descriptor("a", 100, { qpu: qpuEntry("45m") })],
    });
    act(() => root.render(createElement(Label)));
    expect(container.textContent).toBe("QPU");
  });

  test('renders "QPU45m" in normalized mode when a descriptor advertises a 45m budget', () => {
    useTelemetryStore.setState({
      nodeDescriptors: [descriptor("a", 100, { qpu: qpuEntry("45m") })],
    });
    act(() => root.render(createElement(Label, { mode: "normalized" })));
    expect(container.textContent).toBe("QPU45m");
  });

  test('renders "QPU20m" fallback in normalized mode with no QPU descriptor', () => {
    useTelemetryStore.setState({ nodeDescriptors: [] });
    act(() => root.render(createElement(Label, { mode: "normalized" })));
    expect(container.textContent).toBe("QPU20m");
  });
});
