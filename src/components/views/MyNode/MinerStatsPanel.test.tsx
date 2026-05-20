// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MinerStats } from "../../../types/telemetry";

import { MinerStatsPanel } from "./MinerStatsPanel";

// Tiles the panel must surface. Sourced verbatim from the v0.3 plan — the
// panel deliberately omits totalMiningTime, resultsReceived, and staleDrops
// because they're not in the operator-relevant view.
const TILE_LABELS = [
  "Blocks Attempted",
  "Blocks Won",
  "Win Rate",
  "Avg Mining Time",
  "Heads Observed",
  "Contexts Dispatched",
  "Proofs Submitted",
  "Submission Errors",
] as const;

function makeStats(overrides: Partial<MinerStats> = {}): MinerStats {
  return {
    totalBlocksAttempted: 0,
    totalBlocksWon: 0,
    winRate: 0,
    totalMiningTime: 0,
    avgMiningTime: 0,
    headsObserved: 0,
    contextsDispatched: 0,
    resultsReceived: 0,
    proofsSubmitted: 0,
    staleDrops: 0,
    submissionErrors: 0,
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
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(stats: MinerStats) {
  act(() => {
    root.render(createElement(MinerStatsPanel, { stats }));
  });
}

describe("MinerStatsPanel", () => {
  test("renders all eight relevant counter tiles with a populated payload", () => {
    render(
      makeStats({
        totalBlocksAttempted: 1234,
        totalBlocksWon: 42,
        winRate: 0.034,
        avgMiningTime: 12.5,
        headsObserved: 9876,
        contextsDispatched: 5000,
        proofsSubmitted: 4800,
        submissionErrors: 3,
      }),
    );
    for (const label of TILE_LABELS) {
      expect(container.textContent).toContain(label);
    }
  });

  test("handles all-zero stats gracefully (no NaN/Infinity, computed values readable)", () => {
    render(makeStats());
    const text = container.textContent ?? "";
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    // winRate 0 → 0.00%; avgMiningTime 0 → 0.00s. Both are computed from
    // arithmetic, so they're the most likely to blow up on zero input.
    expect(text).toContain("0.00%");
    expect(text).toContain("0.00s");
  });

  // Walks down through grid wrappers to find the leaf StatTile div whose
  // label paragraph reads `label`. Each StatTile renders <label-p, value-p,
  // sublabel-p?> inside a single div — that div is what we want, not its
  // ancestors (which contain every other tile too).
  function findTileByLabel(label: string): HTMLElement | null {
    const labelParas = Array.from(container.querySelectorAll("p")).filter(
      (p) => p.textContent === label,
    );
    if (labelParas.length === 0) return null;
    return labelParas[0].parentElement as HTMLElement | null;
  }

  test("submission errors tile picks up the danger accent when non-zero", () => {
    render(makeStats({ submissionErrors: 7 }));
    // StatTile applies its accent as an inline color; matching the red
    // verifies the conditional accent prop in the panel actually reached
    // the tile that owns "Submission Errors".
    const errorTile = findTileByLabel("Submission Errors");
    expect(errorTile).not.toBeNull();
    const valueEl = errorTile?.querySelector('p[style*="color"]') as HTMLElement | null;
    expect(valueEl).not.toBeNull();
    // rgb(248, 113, 113) == #f87171, the accent the panel passes when errors > 0.
    expect(valueEl?.style.color).toBe("rgb(248, 113, 113)");
  });

  test("submission errors tile uses the default accent when zero", () => {
    render(makeStats({ submissionErrors: 0 }));
    const errorTile = findTileByLabel("Submission Errors");
    expect(errorTile).not.toBeNull();
    const valueEl = errorTile?.querySelector('p[style*="color"]') as HTMLElement | null;
    // Should NOT be the red danger color when there are zero errors.
    expect(valueEl?.style.color).not.toBe("rgb(248, 113, 113)");
  });
});
