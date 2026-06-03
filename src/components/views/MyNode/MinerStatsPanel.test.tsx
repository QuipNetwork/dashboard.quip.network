// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ChainMinerRecord, MinerStats } from "../../../types/telemetry";

import { MinerStatsPanel } from "./MinerStatsPanel";

// Tiles the panel must surface. Primary stats (top row) get prominent
// treatment; diagnostics (bottom row) help operators trace pipeline stalls.
// "Heads Observed" was removed as redundant with Problems Attempted (the
// local pipeline maps 1:1 between observed heads and attempted contexts).
// "Chain Acceptance" surfaces what the pallet actually accepted vs what the
// miner submitted — chain-side metric, complements local "Submission Rate".
const TILE_LABELS = [
  "Problems Attempted",
  "Solutions Computed",
  "Submission Rate",
  "Avg Mining Time",
  "Chain Acceptance",
  "Contexts Dispatched",
  "Proofs Submitted",
  "Stale Drops",
  "Submission Errors",
] as const;

function makeStats(overrides: Partial<MinerStats> = {}): MinerStats {
  return {
    headsObserved: 0,
    contextsDispatched: 0,
    resultsReceived: 0,
    proofsSubmitted: 0,
    staleDrops: 0,
    submissionErrors: 0,
    duplicateResultDrops: 0,
    ...overrides,
  };
}

function makeChainEntry(overrides: Partial<ChainMinerRecord> = {}): ChainMinerRecord {
  return {
    accountId: "5GPPxxOnChainMiner",
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
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

function render(
  stats: MinerStats,
  chainMinerEntry: ChainMinerRecord | null = null,
  selfAvgMiningTimeSec: number | null = null,
  problemsAttempted: number = 0,
  modes: Record<string, import("../../../types/telemetry").ModeBreakdown> | undefined = undefined,
  dataAgeMs: number | null = null,
) {
  act(() => {
    root.render(
      createElement(MinerStatsPanel, {
        stats,
        chainMinerEntry,
        selfAvgMiningTimeSec,
        problemsAttempted,
        modes,
        dataAgeMs,
      }),
    );
  });
}

describe("MinerStatsPanel", () => {
  test("renders all nine relevant counter tiles with a populated payload", () => {
    render(
      makeStats({
        contextsDispatched: 5000,
        proofsSubmitted: 4800,
        staleDrops: 1,
        submissionErrors: 3,
      }),
      makeChainEntry({ proofsSubmitted: "100", proofsWon: "1" }),
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
    // Submission Rate guards against 0/0 by returning em-dash when
    // contextsDispatched is 0 — same shape as Chain Acceptance and Avg
    // Mining Time when their inputs aren't available yet. All four
    // computed cells fall back to em-dash on a fresh miner.
    expect(text).toContain("—");
  });

  test("Submission Rate computes proofsSubmitted/problemsAttempted", () => {
    render(makeStats({ proofsSubmitted: 50 }), null, null, 200);
    const tile = findTileByLabel("Submission Rate");
    expect(tile?.textContent).toContain("25.00%");
  });

  test("Problems Attempted reads from the lifetime counter, not contextsDispatched", () => {
    render(makeStats({ contextsDispatched: 999 }), null, null, 42);
    const tile = findTileByLabel("Problems Attempted");
    expect(tile?.textContent).toContain("42");
    expect(tile?.textContent).not.toContain("999");
  });

  test("Avg Mining Time renders the supplied self-win average", () => {
    render(makeStats(), null, 18.42);
    const tile = findTileByLabel("Avg Mining Time");
    expect(tile?.textContent).toContain("18.42s");
  });

  test("Solutions Computed sub-row surfaces resultsReceived and dedup count", () => {
    // The diagnostic that prompted this: miner reports 3 results received,
    // 1 dedup'd, 2 submitted. The sub-row tells operators why
    // proofsSubmitted (2) is below resultsReceived (3) without shelling
    // into the miner.
    render(makeStats({ resultsReceived: 3, proofsSubmitted: 2, duplicateResultDrops: 1 }));
    const tile = findTileByLabel("Solutions Computed");
    expect(tile).not.toBeNull();
    expect(tile?.textContent).toContain("3 results");
    expect(tile?.textContent).toContain("1 dedup'd");
  });

  test("Solutions Computed sub-row omits dedup chunk when count is zero", () => {
    // When there's no dedup activity the sub-row hides the dedup
    // segment to avoid drawing the eye to a 0. Results count still
    // renders so operators can spot in-flight vs submitted divergence.
    render(makeStats({ resultsReceived: 5, proofsSubmitted: 5, duplicateResultDrops: 0 }));
    const tile = findTileByLabel("Solutions Computed");
    expect(tile?.textContent).toContain("5 results");
    expect(tile?.textContent).not.toContain("dedup");
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
    return labelParas[0]?.parentElement ?? null;
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

  test("Chain Acceptance tile shows chain-side ratio when chainMinerEntry is populated", () => {
    render(makeStats(), makeChainEntry({ proofsSubmitted: "100", proofsWon: "1" }));
    const tile = findTileByLabel("Chain Acceptance");
    expect(tile).not.toBeNull();
    // 1 / 100 = 0.01 → 1.00%. Same operator funnel ratio the user saw in
    // the previous session's docker-logs investigation.
    expect(tile?.textContent).toContain("1.00%");
  });

  test("Chain Acceptance tile shows em-dash when chainMinerEntry is null", () => {
    render(makeStats());
    const tile = findTileByLabel("Chain Acceptance");
    expect(tile).not.toBeNull();
    expect(tile?.textContent).toContain("—");
  });

  test("Chain Acceptance tile shows em-dash when chain submitted is zero", () => {
    render(makeStats(), makeChainEntry({ proofsSubmitted: "0", proofsWon: "0" }));
    const tile = findTileByLabel("Chain Acceptance");
    expect(tile).not.toBeNull();
    // Avoid 0/0 NaN by guarding on chainSubmitted > 0 — verify the em-dash
    // appears in the tile value (sublabel still reads "won / submitted").
    expect(tile?.textContent).toContain("—");
  });

  test("Backends row hidden when modes is undefined or empty", () => {
    // Single-process container: no `modes` data → no per-backend
    // section appears, UI matches pre-W4 layout exactly.
    render(makeStats(), null, null, 0, undefined);
    expect(container.textContent).not.toContain("Backends");

    render(makeStats(), null, null, 0, {});
    expect(container.textContent).not.toContain("Backends");
  });

  test("Backends row renders one entry per active mode in canonical order", () => {
    // Multi-process container: aggregator surfaces per-mode breakdown.
    // The panel renders them in canonical MODE_NAMES order (cpu, gpu,
    // qpu) regardless of dict iteration order so two operators looking
    // at the same data see the same row layout.
    render(makeStats(), null, null, 0, {
      qpu: {
        headsObserved: 50,
        contextsDispatched: 50,
        resultsReceived: 48,
        proofsSubmitted: 2,
        staleDrops: 0,
        submissionErrors: 1,
        duplicateResultDrops: 0,
        miners: [{ id: "rig-QPU-DWAVE-1", type: "QPU" }],
      },
      cpu: {
        headsObserved: 50,
        contextsDispatched: 50,
        resultsReceived: 50,
        proofsSubmitted: 3,
        staleDrops: 1,
        submissionErrors: 0,
        duplicateResultDrops: 0,
        miners: [{ id: "rig-CPU-1", type: "CPU" }],
      },
    });
    expect(container.textContent).toContain("Backends");
    // CPU row appears before QPU row even though `qpu` was first in
    // the input dict — canonical ordering kicks in. Mode keys render
    // lowercase in the DOM (the `uppercase` class is a CSS transform);
    // assert on textContent so we don't depend on CSS resolution.
    const text = container.textContent ?? "";
    expect(text.indexOf("cpu")).toBeGreaterThan(-1);
    expect(text.indexOf("qpu")).toBeGreaterThan(-1);
    expect(text.indexOf("cpu")).toBeLessThan(text.indexOf("qpu"));
  });

  test("data-age footer renders when dataAgeMs is provided", () => {
    // Surfaces "fetched Ns ago" so operators can spot a stalled indexer
    // (last poll minutes/hours old) from the same panel that shows the
    // counters. Uses formatDuration's "s/m/h/d" buckets.
    render(makeStats(), null, null, 0, undefined, 12_500);
    expect(container.textContent).toContain("fetched 12s ago");
  });

  test("data-age footer hidden when dataAgeMs is null (fresh deploy)", () => {
    // Pre-first-poll: no `lastStatusFetchAt` means we can't compute an
    // age. Hide the footer rather than render "fetched 56yr ago" from
    // a 1970 epoch fallback.
    render(makeStats(), null, null, 0, undefined, null);
    expect(container.textContent).not.toContain("fetched");
  });

  test("Backends row submission errors cell uses danger accent when > 0", () => {
    render(makeStats(), null, null, 0, {
      cpu: {
        headsObserved: 10,
        contextsDispatched: 10,
        resultsReceived: 8,
        proofsSubmitted: 0,
        staleDrops: 0,
        submissionErrors: 5,
        duplicateResultDrops: 0,
        miners: [{ id: "rig-CPU-1", type: "CPU" }],
      },
    });
    // The error cell gets the red text class when count > 0 — same
    // visual convention as the headline Submission Errors tile.
    expect(container.innerHTML).toContain("text-brand-red-0");
  });
});
