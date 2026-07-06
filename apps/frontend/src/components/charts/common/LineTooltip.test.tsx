// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PointTooltipProps } from "@nivo/line";

import { createLineTooltip } from "./LineTooltip";

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

function pointFor(serieId: string): PointTooltipProps {
  return {
    point: { serieId, data: { x: 12, y: 3.4 } },
  } as unknown as PointTooltipProps;
}

function render(Tooltip: (p: PointTooltipProps) => JSX.Element, serieId: string): string {
  act(() => {
    root.render(createElement(Tooltip, pointFor(serieId)));
  });
  return container.textContent ?? "";
}

describe("createLineTooltip series explanations (ssf.8)", () => {
  const Tooltip = createLineTooltip({ xLabel: "QBlock", yLabel: "Share" });

  it("appends the extrapolation note for a derived series", () => {
    const text = render(Tooltip, "QPUWC");
    expect(text).toContain("QPUWC");
    expect(text).toMatch(/wall-clock/i);
  });

  it("shows no explanation line for a self-explanatory series", () => {
    const text = render(Tooltip, "CPU");
    expect(text).toContain("CPU");
    expect(text).not.toMatch(/wall-clock|extrapolat|budget/i);
  });
});
