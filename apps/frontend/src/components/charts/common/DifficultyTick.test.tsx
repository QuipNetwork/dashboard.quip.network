// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The difficulty axes render each tick as two angled lines — "0.746" over
// "(-14540)" — via a custom nivo renderTick. Without the curve constant K
// there is no curve ratio, so the tick falls back to one raw-energy line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createDifficultyTickRenderer, type DifficultyTickProps } from "./DifficultyTick";

const K = 19493; // live default-topology constant

const tickProps: DifficultyTickProps = {
  value: -14_540,
  x: 100,
  y: 0,
  lineX: 0,
  lineY: 5,
  textX: 0,
  textY: 10,
  rotate: -30,
  textAnchor: "end",
  textBaseline: "central",
};

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

function renderTick(k: number | null): void {
  const Tick = createDifficultyTickRenderer(k);
  act(() => {
    root.render(createElement("svg", null, createElement(Tick, tickProps)));
  });
}

describe("createDifficultyTickRenderer", () => {
  test("renders the curve ratio centered over the raw energy", () => {
    renderTick(K);
    const lines = [...container.querySelectorAll("tspan")].map((t) => t.textContent);
    expect(lines).toEqual(["0.746", "(-14540)"]);
    // Centered as a block: both lines share an anchor point midway, not a
    // right edge (which leaves the shorter ratio line hanging off to a side).
    expect(container.querySelector("text")!.getAttribute("text-anchor")).toBe("middle");
    const xs = [...container.querySelectorAll("tspan")].map((t) => t.getAttribute("x"));
    expect(xs[0]).toBe(xs[1]);
  });

  test("falls back to a single raw-energy line without K", () => {
    renderTick(null);
    const lines = [...container.querySelectorAll("tspan")].map((t) => t.textContent);
    expect(lines).toEqual(["-14540"]);
  });
});
