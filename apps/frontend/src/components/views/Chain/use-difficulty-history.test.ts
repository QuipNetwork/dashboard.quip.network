// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Price-panel windowing for the difficulty chart (task #25, spec §10.5).
// Pure parts: range → since cutoff, and response → step-series points
// (anchor injected at the window start, last value extended to "now" so the
// step reaches the right edge — no dead whitespace on either side).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { createTestServices } from "@/testing/services";
import type { DifficultyHistoryResponse, DifficultyRecord } from "@quip/shared/telemetry";

import {
  buildSeriesPoints,
  sinceForRange,
  useDifficultyHistory,
  type DifficultyHistoryState,
} from "./use-difficulty-history";

// 2026-07-02T12:00:00.000Z — fixed wall-clock for every windowing assertion.
const NOW = Date.parse("2026-07-02T12:00:00.000Z");

const row = (observedAt: string, energy: number): DifficultyRecord => ({
  observedAtBlock: "1",
  difficultyEnergy: energy,
  minDiversity: 0,
  minSolutions: 1,
  observedAt,
  topologyHash: null,
  source: "block",
});

describe("sinceForRange", () => {
  test("fixed windows subtract from now", () => {
    expect(sinceForRange("1h", NOW)).toBe("2026-07-02T11:00:00.000Z");
    expect(sinceForRange("6h", NOW)).toBe("2026-07-02T06:00:00.000Z");
    expect(sinceForRange("12h", NOW)).toBe("2026-07-02T00:00:00.000Z");
    expect(sinceForRange("24h", NOW)).toBe("2026-07-01T12:00:00.000Z");
    expect(sinceForRange("7d", NOW)).toBe("2026-06-25T12:00:00.000Z");
    expect(sinceForRange("1m", NOW)).toBe("2026-06-02T12:00:00.000Z");
  });

  test("ytd starts at Jan 1 UTC of the current year", () => {
    expect(sinceForRange("ytd", NOW)).toBe("2026-01-01T00:00:00.000Z");
  });

  test("all time starts at the epoch — the server returns from the first measurement", () => {
    expect(sinceForRange("all", NOW)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("buildSeriesPoints", () => {
  const since = "2026-07-02T11:00:00.000Z";

  test("anchor becomes the step start at the window edge; last value extends to now", () => {
    const resp: DifficultyHistoryResponse = {
      since,
      anchor: row("2026-07-02T09:00:00.000Z", -14_500),
      rows: [row("2026-07-02T11:30:00.000Z", -14_520)],
    };
    const points = buildSeriesPoints(resp, NOW);
    expect(points).toEqual([
      { x: new Date(since), y: -14_500 }, // prevailing value at the left edge
      { x: new Date("2026-07-02T11:30:00.000Z"), y: -14_520 },
      { x: new Date(NOW), y: -14_520 }, // step extended to the right edge
    ]);
  });

  test("a stable-difficulty window (no rows) still renders a flat prevailing line", () => {
    const resp: DifficultyHistoryResponse = {
      since,
      anchor: row("2026-07-01T00:00:00.000Z", -14_400),
      rows: [],
    };
    expect(buildSeriesPoints(resp, NOW)).toEqual([
      { x: new Date(since), y: -14_400 },
      { x: new Date(NOW), y: -14_400 },
    ]);
  });

  test("no anchor (window predates the first measurement) starts at the first row", () => {
    const resp: DifficultyHistoryResponse = {
      since: "1970-01-01T00:00:00.000Z",
      anchor: null,
      rows: [row("2026-06-23T00:00:00.000Z", -14_495), row("2026-07-01T00:00:00.000Z", -14_530)],
    };
    const points = buildSeriesPoints(resp, NOW);
    expect(points[0]).toEqual({ x: new Date("2026-06-23T00:00:00.000Z"), y: -14_495 });
    expect(points[points.length - 1]).toEqual({ x: new Date(NOW), y: -14_530 });
  });

  test("no data at all → empty", () => {
    expect(buildSeriesPoints({ since, anchor: null, rows: [] }, NOW)).toEqual([]);
  });
});

describe("useDifficultyHistory", () => {
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

  function makeClient(): { client: TelemetryClient; calls: string[] } {
    const calls: string[] = [];
    const client: TelemetryClient = {
      fetchTelemetry: () => new Promise<never>(() => {}),
      fetchMiningAttempts: () => new Promise<never>(() => {}),
      fetchBlocks: () => new Promise<never>(() => {}),
      fetchNodeLive: () => new Promise<never>(() => {}),
      fetchMinerWins: () => new Promise<never>(() => {}),
      fetchDifficultyHistory: async (sinceIso: string) => {
        calls.push(sinceIso);
        return {
          since: sinceIso,
          anchor: row("2026-07-02T09:00:00.000Z", -14_500),
          rows: [row("2026-07-02T11:30:00.000Z", -14_520)],
        };
      },
    };
    return { client, calls };
  }

  function renderHook(
    client: TelemetryClient,
    range: "1h" | "24h",
  ): { current: DifficultyHistoryState } {
    const result = { current: {} as DifficultyHistoryState };
    function Probe({ r }: { r: "1h" | "24h" }): null {
      result.current = useDifficultyHistory(r, { now: () => NOW });
      return null;
    }
    const services = createTestServices({ client });
    act(() => {
      root.render(
        createElement(ServicesProvider, {
          ...services,
          children: createElement(Probe, { r: range }),
        }),
      );
    });
    return result;
  }

  test("fetches the selected window and exposes chart-ready points", async () => {
    const { client, calls } = makeClient();
    const result = renderHook(client, "1h");
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual(["2026-07-02T11:00:00.000Z"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.points).toHaveLength(3); // anchor + row + now-extension
    expect(result.current.isEmpty).toBe(false);
  });
});
