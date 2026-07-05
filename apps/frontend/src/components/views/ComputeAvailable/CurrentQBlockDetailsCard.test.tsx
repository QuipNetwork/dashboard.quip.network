// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, DifficultyRecord } from "@quip/shared/telemetry";

import { CurrentQBlockDetailsCard } from "./CurrentQBlockDetailsCard";

function makeDifficultyRecord(overrides: Partial<DifficultyRecord> = {}): DifficultyRecord {
  return {
    observedAtBlock: "100",
    difficultyEnergy: -120,
    minDiversity: 0.2,
    minSolutions: 2,
    observedAt: "2026-01-01T00:00:00.000Z",
    topologyHash: null,
    source: "poll",
    ...overrides,
  };
}

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "162",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GBob",
    energy: -105,
    diversity: 0.482,
    numValidSolutions: 3,
    miningTime: 42,
    deviceAccessTimeUs: null,
    reward: "1000000000000",
    qblockId: "163",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
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
});

describe("CurrentQBlockDetailsCard", () => {
  test("renders the next QBlock number, FLOPS, and elapsed time", () => {
    act(() => {
      root.render(
        createElement(CurrentQBlockDetailsCard, {
          lastBlock: makeBlock(),
          currentBlockPflopSeconds: 5.67,
          currentBlockElapsedSeconds: 30,
          currentDifficulty: null,
          recentDifficulty: [],
          decays: null,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Current QBlock Details");
    expect(text).toContain("#163");
    expect(text).toContain("5.7 PFLOP·s");
    expect(text).toContain("30s and counting");
  });

  test("shows the awaiting-first-block empty state when there is neither a block nor a difficulty", () => {
    act(() => {
      root.render(
        createElement(CurrentQBlockDetailsCard, {
          lastBlock: null,
          currentBlockPflopSeconds: null,
          currentBlockElapsedSeconds: null,
          currentDifficulty: null,
          recentDifficulty: [],
          decays: null,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Current QBlock Details");
    expect(text).toContain("Awaiting first block");
    expect(text).not.toContain("QBlock #");
  });

  test("renders difficulty rows, Decays Applied, and Prior rows deduped by energy", () => {
    act(() => {
      root.render(
        createElement(CurrentQBlockDetailsCard, {
          lastBlock: makeBlock(),
          currentBlockPflopSeconds: 5.67,
          currentBlockElapsedSeconds: 30,
          currentDifficulty: { difficultyEnergy: -120, minDiversity: 0.25, minSolutions: 2 },
          recentDifficulty: [
            makeDifficultyRecord({ observedAtBlock: "163", difficultyEnergy: -120 }),
            makeDifficultyRecord({ observedAtBlock: "150", difficultyEnergy: -110 }),
            // Duplicate energy of the #150 row — deduped, not a second Prior row.
            makeDifficultyRecord({ observedAtBlock: "140", difficultyEnergy: -110 }),
            makeDifficultyRecord({ observedAtBlock: "130", difficultyEnergy: -100 }),
          ],
          decays: 2,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Target Energy");
    expect(text).toContain("120");
    expect(text).toContain("Min Diversity");
    expect(text).toContain("0.250");
    expect(text).toContain("Min Solutions");
    expect(text).toContain("Decays Applied");
    expect(text).toContain("2");
    expect(text).toContain("Prior @ #150");
    expect(text).toContain("Prior @ #130");
    expect(text).not.toContain("Prior @ #140");
  });

  test("shows the italic not-enforced treatment for zero-valued diversity/solutions", () => {
    act(() => {
      root.render(
        createElement(CurrentQBlockDetailsCard, {
          lastBlock: makeBlock(),
          currentBlockPflopSeconds: 5.67,
          currentBlockElapsedSeconds: 30,
          currentDifficulty: { difficultyEnergy: -120, minDiversity: 0, minSolutions: 0 },
          recentDifficulty: [],
          decays: null,
        }),
      );
    });
    const notEnforced = [...container.querySelectorAll("dd")].filter(
      (dd) => dd.textContent === "not enforced",
    );
    expect(notEnforced.length).toBe(2);
    expect(notEnforced.every((dd) => dd.querySelector("span.italic") != null)).toBe(true);
  });
});
