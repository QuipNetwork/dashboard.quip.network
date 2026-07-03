// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import { createTestServices, type TestServices } from "@/testing/services";
import type { ChainMinerRecord, NodeDescriptorRecord } from "@quip/shared/telemetry";
import { ChainMinersTable, filterChainMiners } from "./ChainMinersView";

function miner(accountId: string): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
  };
}

function descriptor(
  accountId: string,
  nodeName: string,
  quipVersion: string,
): NodeDescriptorRecord {
  return {
    accountId,
    descriptor: { nodeName, runtime: { quipVersion } },
  } as unknown as NodeDescriptorRecord;
}

const MINERS = [miner("5Alpha"), miner("5Beta")];
const DESCRIPTORS = new Map<string, NodeDescriptorRecord>([
  ["5Alpha", descriptor("5Alpha", "alpha-rig", "0.3.1")],
  ["5Beta", descriptor("5Beta", "beta-rig", "0.2.9")],
]);

describe("filterChainMiners", () => {
  it("returns all miners for an empty query", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "")).toHaveLength(2);
  });

  it("matches on account id", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "beta").map((m) => m.accountId)).toEqual([
      "5Beta",
    ]);
  });

  it("matches on joined rig name", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "alpha-rig").map((m) => m.accountId)).toEqual([
      "5Alpha",
    ]);
  });

  it("matches on joined quip version", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "0.2.9").map((m) => m.accountId)).toEqual([
      "5Beta",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterChainMiners(MINERS, DESCRIPTORS, "zzz")).toHaveLength(0);
  });
});

describe("ChainMinersTable node identity modal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let services: TestServices;

  function moreInfoButton(): HTMLButtonElement | null {
    return (
      Array.from(container.querySelectorAll("button")).find((b) =>
        /more info/i.test(b.textContent ?? ""),
      ) ?? null
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    services = createTestServices({
      telemetry: {
        chainMiners: [miner("5Alpha")],
        nodeDescriptors: [descriptor("5Alpha", "alpha-rig", "0.3.1")],
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderTable() {
    act(() => {
      root.render(
        <ServicesProvider {...services}>
          <ChainMinersTable />
        </ServicesProvider>,
      );
    });
  }

  it("opens the identity modal with a More info link that navigates to the node page", () => {
    renderTable();

    // No modal until a row is clicked.
    expect(moreInfoButton()).toBeNull();

    const row = container.querySelector<HTMLTableRowElement>("tbody tr");
    expect(row).not.toBeNull();
    act(() => row?.click());

    const link = moreInfoButton();
    expect(link).not.toBeNull();

    act(() => link?.click());

    expect(services.uiStore.getState().viewMode).toBe("node");
    expect(services.uiStore.getState().selectedNodeId).toBe("5Alpha");
  });
});
