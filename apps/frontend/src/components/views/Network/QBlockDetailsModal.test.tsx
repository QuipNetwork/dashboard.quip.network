// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord } from "@quip/shared/telemetry";

import { QBlockDetailsModal } from "./QBlockDetailsModal";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GWinner",
    energy: -14_500,
    diversity: 0.5,
    numValidSolutions: 3,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "42",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -14_400,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function moreInfoButton(): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      /more info/i.test(b.textContent ?? ""),
    ) ?? null
  );
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

describe("QBlockDetailsModal winner more-info", () => {
  test("renders a More info affordance and calls onWinnerMoreInfo when clicked", () => {
    let clicked = 0;
    act(() => {
      root.render(
        createElement(QBlockDetailsModal, {
          block: makeBlock(),
          solutionNumber: 42,
          onClose: () => {},
          onWinnerMoreInfo: () => {
            clicked += 1;
          },
        }),
      );
    });

    const btn = moreInfoButton();
    expect(btn).not.toBeNull();

    act(() => {
      btn?.click();
    });
    expect(clicked).toBe(1);
  });

  test("omits the More info affordance when no callback is provided", () => {
    act(() => {
      root.render(
        createElement(QBlockDetailsModal, {
          block: makeBlock(),
          solutionNumber: 42,
          onClose: () => {},
        }),
      );
    });
    expect(moreInfoButton()).toBeNull();
  });
});
