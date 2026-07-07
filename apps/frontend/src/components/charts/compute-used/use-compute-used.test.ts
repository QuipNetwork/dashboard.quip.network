// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useComputeUsed now sources the "Total Compute Used" pie from the
// participant-level aggregate (every node that raced a qblock, all device
// kinds) rather than the old winner-only per-block scan — so the totals are
// network-wide device access, not just the winning proof's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ParticipationComputeRow } from "@quip/shared/telemetry";
import { QPU_ACCESS_TO_WALL_RATIO } from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";

import { useComputeUsed, type ComputeUsedEntry } from "./use-compute-used";

// ---- Fixtures ----------------------------------------------------------

function row(overrides: Partial<ParticipationComputeRow> = {}): ParticipationComputeRow {
  return {
    qblockId: "1",
    account: "5GCpu",
    kind: "Cpu",
    miningSeconds: 60,
    exactQpuAccessUs: null,
    ...overrides,
  };
}

// ---- Harness -----------------------------------------------------------

function renderHook(): { current: ComputeUsedEntry[] } {
  const result: { current: ComputeUsedEntry[] } = { current: [] };
  function Probe(): null {
    result.current = useComputeUsed();
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ participationCompute: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---- Tests -------------------------------------------------------------

describe("useComputeUsed", () => {
  test("sums device access across ALL participants per category, not winner-only", () => {
    useTelemetryStore.setState({
      participationCompute: [
        row({ qblockId: "1", account: "A", miningSeconds: 60 }),
        row({ qblockId: "1", account: "B", miningSeconds: 30 }), // co-racer on same qblock
        row({ qblockId: "2", account: "A", miningSeconds: 40 }),
      ],
    });
    const cpu = renderHook().current.find((e) => e.minerType === "CPU");
    // 60 + 30 + 40 — every participant counts, not just the qblock's winner.
    expect(cpu?.compute).toBe(130);
    expect(cpu?.estimated).toBe(true);
  });

  test("QPU exact self-reported access time is used directly and marked not-estimated", () => {
    useTelemetryStore.setState({
      participationCompute: [
        row({ account: "Q", kind: "Qpu", miningSeconds: 999, exactQpuAccessUs: 50_000_000 }),
      ],
    });
    const qpu = renderHook().current.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBe(50); // 50_000_000us -> 50s, not the 999s wall clock
    expect(qpu?.estimated).toBe(false);
  });

  test("QPU without exact telemetry uses the wall/ratio estimate", () => {
    useTelemetryStore.setState({
      participationCompute: [
        row({ account: "Q", kind: "Qpu", miningSeconds: QPU_ACCESS_TO_WALL_RATIO * 3 }),
      ],
    });
    const qpu = renderHook().current.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBeCloseTo(3, 6);
    expect(qpu?.estimated).toBe(true);
  });

  test("a tiny-but-real QPU total is floored to a visible slice next to a huge CPU total", () => {
    useTelemetryStore.setState({
      participationCompute: [
        row({ qblockId: "1", account: "C", kind: "Cpu", miningSeconds: 100_000 }),
        // 0.05s of real QPU chip access — invisible next to 100_000s.
        row({ qblockId: "1", account: "Q", kind: "Qpu", exactQpuAccessUs: 50_000 }),
      ],
    });
    const entries = renderHook().current;
    const qpu = entries.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBeCloseTo(0.05, 6); // true value unchanged for labels/tooltips
    expect(qpu?.floored).toBe(true);
    expect(qpu?.displayCompute).toBeGreaterThan(qpu!.compute); // slice value raised
  });

  test("a truly-zero-second category is not floored", () => {
    useTelemetryStore.setState({
      participationCompute: [
        row({ qblockId: "1", account: "C", kind: "Cpu", miningSeconds: 100 }),
        row({ qblockId: "1", account: "Q", kind: "Qpu", miningSeconds: 0, exactQpuAccessUs: 0 }),
      ],
    });
    const qpu = renderHook().current.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBe(0);
    expect(qpu?.displayCompute).toBe(0);
    expect(qpu?.floored).toBe(false);
  });

  test("categories come back in the fixed CPU, GPU, QPU order regardless of row order", () => {
    useTelemetryStore.setState({
      participationCompute: [
        row({ account: "Q", kind: "Qpu", miningSeconds: 10 }),
        row({ account: "C", kind: "Cpu", miningSeconds: 10 }),
        row({ account: "G", kind: "Gpu", miningSeconds: 10 }),
      ],
    });
    expect(renderHook().current.map((e) => e.minerType)).toEqual(["CPU", "GPU", "QPU"]);
  });

  test("no participation rows yields an empty dataset", () => {
    expect(renderHook().current).toEqual([]);
  });
});
