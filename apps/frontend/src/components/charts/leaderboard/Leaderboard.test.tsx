// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Leaderboard } from "./Leaderboard";
import { filterLeaderboardEntries, type LeaderboardEntry } from "./use-leaderboard";

function entry(
  overrides: Partial<LeaderboardEntry> & Pick<LeaderboardEntry, "minerId">,
): LeaderboardEntry {
  return {
    rank: 1,
    minerCategory: "GPU",
    blockCount: 10,
    share: 0.5,
    avgMiningTime: 3,
    bestEnergy: -15000,
    ...overrides,
  };
}

const ENTRIES: LeaderboardEntry[] = [
  entry({ rank: 1, minerId: "alpha", minerCategory: "GPU" }),
  entry({ rank: 2, minerId: "beta", minerCategory: "CPU" }),
  entry({ rank: 3, minerId: "gamma", minerCategory: "QPU" }),
];

describe("filterLeaderboardEntries", () => {
  it("returns all entries for an empty query", () => {
    expect(filterLeaderboardEntries(ENTRIES, "")).toHaveLength(3);
    expect(filterLeaderboardEntries(ENTRIES, "   ")).toHaveLength(3);
  });

  it("matches on miner id, case-insensitively", () => {
    const out = filterLeaderboardEntries(ENTRIES, "BET");
    expect(out.map((e) => e.minerId)).toEqual(["beta"]);
  });

  it("matches on miner category", () => {
    const out = filterLeaderboardEntries(ENTRIES, "qpu");
    expect(out.map((e) => e.minerId)).toEqual(["gamma"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterLeaderboardEntries(ENTRIES, "zzz")).toHaveLength(0);
  });
});

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

function typeSearch(value: string) {
  const input = container.querySelector('input[type="search"]') as HTMLInputElement;
  const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

describe("Leaderboard search", () => {
  it("renders every row before any search", () => {
    act(() => root.render(createElement(Leaderboard, { data: ENTRIES })));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("filters rows as the operator types", () => {
    act(() => root.render(createElement(Leaderboard, { data: ENTRIES })));

    typeSearch("alpha");

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("beta");
  });

  it("shows an empty message when nothing matches", () => {
    act(() => root.render(createElement(Leaderboard, { data: ENTRIES })));

    typeSearch("zzz");

    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(container.textContent).toContain("No miners match");
  });
});
