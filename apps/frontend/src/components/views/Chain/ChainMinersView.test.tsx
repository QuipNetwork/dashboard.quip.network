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

describe("ChainMinersTable sorting", () => {
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

  function renderWith(miners: ChainMinerRecord[], descriptors: NodeDescriptorRecord[]) {
    const services = createTestServices({
      telemetry: { chainMiners: miners, nodeDescriptors: descriptors },
    });
    act(() => {
      root.render(
        <ServicesProvider {...services}>
          <ChainMinersTable />
        </ServicesProvider>,
      );
    });
  }

  function firstColumn(): string[] {
    return Array.from(container.querySelectorAll("tbody tr td:first-child")).map(
      (td) => td.textContent ?? "",
    );
  }

  function header(label: RegExp): HTMLTableCellElement {
    const th = Array.from(container.querySelectorAll("th")).find((h) =>
      label.test(h.textContent ?? ""),
    );
    if (!th) throw new Error(`no header matching ${label}`);
    return th;
  }

  // Participation falls back to the descriptor's blockTimestamp when the
  // account has no won block in the rolling window.
  function stampedDescriptor(accountId: string, name: string, ts: number): NodeDescriptorRecord {
    return {
      accountId,
      blockTimestamp: ts,
      descriptor: { nodeName: name },
    } as unknown as NodeDescriptorRecord;
  }

  const SORT_MINERS = [
    miner("5Never"),
    { ...miner("5Old"), deposit: "900" },
    { ...miner("5New"), deposit: "100" },
  ];
  const SORT_DESCRIPTORS = [
    stampedDescriptor("5Old", "old-rig", 100),
    stampedDescriptor("5New", "new-rig", 200),
  ];

  it("defaults to last participation, most recent first, never-seen last", () => {
    renderWith(SORT_MINERS, SORT_DESCRIPTORS);
    expect(firstColumn()).toEqual(["new-rig", "old-rig", "5Never"]);
    expect(header(/Last participation/i).getAttribute("aria-sort")).toBe("descending");
  });

  it("toggles direction when the active column is clicked again", () => {
    renderWith(SORT_MINERS, SORT_DESCRIPTORS);
    act(() => header(/Last participation/i).click());
    expect(header(/Last participation/i).getAttribute("aria-sort")).toBe("ascending");
    expect(firstColumn()).toEqual(["old-rig", "new-rig", "5Never"]);
  });

  it("sorts by another column on click, descending first", () => {
    renderWith(SORT_MINERS, SORT_DESCRIPTORS);
    act(() => header(/Deposit/i).click());
    expect(header(/Deposit/i).getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn()).toEqual(["old-rig", "new-rig", "5Never"]);
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
