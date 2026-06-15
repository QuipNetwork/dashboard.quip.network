// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord } from "@/types/telemetry";

import { FinalityBadge } from "./FinalityBadge";

function block(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "h",
    substrateBlockNumber: "1",
    substrateBlockHash: "sh",
    substrateParentHash: "ph",
    timestamp: 1,
    minerId: "m",
    energy: 0,
    diversity: 0,
    numValidSolutions: 0,
    miningTime: 0,
    reward: "0",
    nonce: "0",
    numNodes: 0,
    numEdges: 0,
    difficultyEnergy: 0,
    minDiversity: 0,
    minSolutions: 0,
    finalized: false,
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

describe("FinalityBadge", () => {
  test("renders 'pending' when not finalized", () => {
    act(() => {
      root.render(
        createElement(FinalityBadge, {
          block: block({ substrateBlockNumber: "42", finalized: false }),
        }),
      );
    });
    expect(container.textContent).toContain("pending");
  });

  test("renders 'finalized' when finalized=true", () => {
    act(() => {
      root.render(
        createElement(FinalityBadge, {
          block: block({ substrateBlockNumber: "42", finalized: true }),
        }),
      );
    });
    expect(container.textContent).toContain("finalized");
    expect(container.textContent).not.toContain("pending");
  });
});
