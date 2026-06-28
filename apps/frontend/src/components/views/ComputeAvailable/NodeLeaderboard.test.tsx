// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { filterNodes, NodeLeaderboard } from "./NodeLeaderboard";
import type { PerNodeTflops } from "./use-compute-available";

const NODES: PerNodeTflops[] = [
  { address: "5Alpha", nodeName: "alpha-rig", tflops: 12 },
  { address: "5Beta", nodeName: "beta-rig", tflops: 8 },
];

describe("filterNodes", () => {
  it("returns all nodes for an empty query", () => {
    expect(filterNodes(NODES, "")).toHaveLength(2);
  });

  it("matches on node name and address, case-insensitively", () => {
    expect(filterNodes(NODES, "ALPHA").map((n) => n.address)).toEqual(["5Alpha"]);
    expect(filterNodes(NODES, "5beta").map((n) => n.nodeName)).toEqual(["beta-rig"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterNodes(NODES, "zzz")).toHaveLength(0);
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

describe("NodeLeaderboard search", () => {
  it("shows an empty message when the query matches no nodes", () => {
    act(() => root.render(createElement(NodeLeaderboard, { nodes: NODES, accent: "#67E347" })));

    typeSearch("zzz");

    expect(container.textContent).toContain("No nodes match");
  });
});
