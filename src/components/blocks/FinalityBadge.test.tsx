// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord } from "../../types/telemetry";

import { FinalityBadge } from "./FinalityBadge";

function block(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    epoch: "abc",
    blockIndex: 1,
    blockHash: "h",
    timestamp: 1,
    previousHash: "p",
    minerId: "m",
    minerCategory: "CPU",
    ecdsaPublicKey: "k",
    energy: 0,
    diversity: 0,
    numValidSolutions: 0,
    miningTime: 0,
    nonce: "0",
    numNodes: 0,
    numEdges: 0,
    difficultyEnergy: 0,
    minDiversity: 0,
    minSolutions: 0,
    substrateBlockNumber: null,
    substrateBlockHash: null,
    substrateParentHash: null,
    extrinsicsRoot: null,
    stateRoot: null,
    finalized: false,
    isCanonical: true,
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
  test("renders nothing when substrate block isn't joined yet", () => {
    act(() => {
      root.render(createElement(FinalityBadge, { block: block({ substrateBlockNumber: null }) }));
    });
    expect(container.textContent).toBe("");
  });

  test("renders 'pending' when substrate block known but not finalized", () => {
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
