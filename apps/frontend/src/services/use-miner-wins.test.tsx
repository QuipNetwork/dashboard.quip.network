// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared fetch hook for /api/miner-wins — every "qblocks won" surface
// (leaderboard, rank-adjacent miners, miner info panes) reads this one
// dataset so the numbers agree by construction.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { createTestServices } from "@/testing/services";
import type { MinerWinsRow } from "@quip/shared/telemetry";

import { useMinerWins, type MinerWinsState } from "./use-miner-wins";

const ROWS: MinerWinsRow[] = [
  { minerId: "5A", wins: 12, bestEnergy: -3.5, avgMiningTime: 9, lastWonAt: 1700000200 },
  { minerId: "5B", wins: 4, bestEnergy: -1.5, avgMiningTime: 14, lastWonAt: 1700000100 },
];

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

function makeClient(rows: MinerWinsRow[] | Error): { client: TelemetryClient; calls: number[] } {
  const calls: number[] = [];
  const client: TelemetryClient = {
    fetchTelemetry: () => new Promise<never>(() => {}),
    fetchMiningAttempts: () => new Promise<never>(() => {}),
    fetchBlocks: () => new Promise<never>(() => {}),
    fetchNodeLive: () => new Promise<never>(() => {}),
    fetchDifficultyHistory: () => new Promise<never>(() => {}),
    fetchMiningHistory: () => new Promise<never>(() => {}),
    fetchMinerWins: async () => {
      calls.push(calls.length);
      if (rows instanceof Error) throw rows;
      return { rows };
    },
  };
  return { client, calls };
}

function renderHook(client: TelemetryClient): { current: MinerWinsState } {
  const result = { current: {} as MinerWinsState };
  function Probe(): null {
    result.current = useMinerWins();
    return null;
  }
  const services = createTestServices({ client });
  act(() => {
    root.render(createElement(ServicesProvider, { ...services, children: createElement(Probe) }));
  });
  return result;
}

describe("useMinerWins", () => {
  test("fetches once on mount and exposes rows plus a by-miner index", async () => {
    const { client, calls } = makeClient(ROWS);
    const result = renderHook(client);
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.rows).toEqual(ROWS);
    expect(result.current.byMiner.get("5B")?.wins).toBe(4);
    expect(result.current.error).toBeNull();
  });

  test("surfaces fetch failures as error state, keeping prior rows empty", async () => {
    const { client } = makeClient(new Error("boom"));
    const result = renderHook(client);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("boom");
    expect(result.current.rows).toEqual([]);
  });
});
