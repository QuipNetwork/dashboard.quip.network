// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { MineableTopologyRecord } from "@quip/shared/telemetry";

import { MineableTopologiesPanel } from "./MineableTopologiesPanel";

const topology = (overrides: Partial<MineableTopologyRecord>): MineableTopologyRecord => ({
  topologyHash: "0x909cfee75bab5cb9de3ee73b763f3b974720da51a2db3b5073d94e0d85526971",
  isDefault: true,
  difficultyEnergy: -4850,
  minDiversity: 0,
  minSolutions: 1,
  nodeCount: 4575,
  edgeCount: 41474,
  curveConstant: null,
  family: null,
  energyBand: null,
  ...overrides,
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
  useTelemetryStore.setState({ mineableTopologies: [] });
});

function renderRows(topologies: MineableTopologyRecord[]): string[][] {
  useTelemetryStore.setState({ mineableTopologies: topologies });
  act(() => {
    root.render(createElement(MineableTopologiesPanel));
  });
  return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
  );
}

describe("MineableTopologiesPanel", () => {
  test("a family topology shows family@revision, its band, and the target's band position", () => {
    const [row] = renderRows([
      topology({
        family: { familyId: "quip/twisted-ice-dimer", revision: 1 },
        energyBand: { hardEnergy: -5100, easyEnergy: -4800 },
      }),
    ]);
    expect(row?.[1]).toBe("quip/twisted-ice-dimer@1");
    expect(row?.[2]).toBe("-5100 … -4800");
    expect(row?.[3]).toBe("-4850(0.833)");
  });

  test("a legacy topology shows no family or band and no band position", () => {
    const [row] = renderRows([topology({ curveConstant: 19480.43 })]);
    expect(row?.[1]).toBe("—");
    expect(row?.[2]).toBe("—");
    expect(row?.[3]).toBe("-4850");
  });
});
