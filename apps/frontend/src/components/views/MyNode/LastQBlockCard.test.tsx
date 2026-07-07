// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord } from "@quip/shared/telemetry";

import { LastQBlockCard } from "./LastQBlockCard";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xblock1042",
    substrateBlockNumber: "1042",
    substrateBlockHash: "0xsub1042",
    substrateParentHash: "0xsub1041",
    timestamp: 1_700_000_000,
    minerId: "quantum-rig-01",
    energy: -15420,
    diversity: 0.42,
    numValidSolutions: 2,
    miningTime: 1.2,
    deviceAccessTimeUs: null,
    reward: "1000000000000",
    qblockId: "1042",
    nonce: "104200",
    numNodes: 120,
    numEdges: 240,
    difficultyEnergy: -15500,
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

describe("LastQBlockCard", () => {
  test("renders a Target Energy row from the block's difficultyEnergy", () => {
    act(() => {
      root.render(
        createElement(LastQBlockCard, {
          lastWonBlock: makeBlock(),
          lastWonSubmission: undefined,
          lastWonProblemNumber: 1042,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Target Energy");
    expect(text).toContain("-15500");
    // Existing Energy row (actual, not target) still present and distinct.
    expect(text).toContain("Energy");
    expect(text).toContain("-15420");
  });

  test("omits the Target Energy row in the no-wins-yet empty state", () => {
    act(() => {
      root.render(
        createElement(LastQBlockCard, {
          lastWonBlock: null,
          lastWonSubmission: undefined,
          lastWonProblemNumber: null,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("No wins yet");
    expect(text).not.toContain("Target Energy");
  });
});
