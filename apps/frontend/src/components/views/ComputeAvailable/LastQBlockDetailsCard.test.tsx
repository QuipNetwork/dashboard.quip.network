// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord } from "@quip/shared/telemetry";

import { LastQBlockDetailsCard } from "./LastQBlockDetailsCard";

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

describe("LastQBlockDetailsCard", () => {
  test("renders block, compute, and difficulty rows from the fixture block", () => {
    act(() => {
      root.render(
        createElement(LastQBlockDetailsCard, {
          lastBlock: makeBlock(),
          lastBlockPflopSeconds: 12.34,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Last QBlock Details");
    expect(text).toContain("#162");
    expect(text).toContain("12.3 PFLOP·s");
    expect(text).toContain("Solved In");
    expect(text).toContain("Energy");
    expect(text).toContain("-105");
    expect(text).toContain("0.482");
    expect(text).toContain("Solutions");
    expect(text).toContain("3");
  });

  test("shows the awaiting-first-block empty state when there is no block yet", () => {
    act(() => {
      root.render(
        createElement(LastQBlockDetailsCard, { lastBlock: null, lastBlockPflopSeconds: null }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Last QBlock Details");
    expect(text).toContain("Awaiting first block");
    expect(text).not.toContain("QBlock #");
  });
});
