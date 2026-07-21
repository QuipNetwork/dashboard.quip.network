// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import { createTestServices, type TestServices } from "@/testing/services";
import type { ChainMinerRecord, NodeDescriptorRecord } from "@quip/shared/telemetry";
import { ChainMinersTable, filterChainMiners, isStaleNeverMiner } from "./ChainMinersView";
import { FOURTEEN_DAYS_MS } from "@/components/views/ComputeAvailable/use-compute-available";

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

describe("isStaleNeverMiner", () => {
  const NOW = 1_700_000_000_000;
  const staleSec = Math.floor((NOW - FOURTEEN_DAYS_MS - 1000) / 1000);
  const recentSec = Math.floor((NOW - 1000) / 1000);

  it("prunes a zero-win miner whose last participation is older than 2 weeks", () => {
    expect(isStaleNeverMiner(miner("5X"), staleSec, NOW)).toBe(true);
  });

  it("keeps a zero-win miner seen within the last 2 weeks", () => {
    expect(isStaleNeverMiner(miner("5X"), recentSec, NOW)).toBe(false);
  });

  it("keeps a miner that has ever won, however stale", () => {
    expect(isStaleNeverMiner({ ...miner("5X"), proofsWon: "3" }, staleSec, NOW)).toBe(false);
  });

  it("keeps a zero-win miner with unknown activity (null timestamp)", () => {
    // A registered miner that never announced a descriptor and never won has
    // no activity timestamp — we cannot prove it is stale, so we keep it.
    expect(isStaleNeverMiner(miner("5X"), null, NOW)).toBe(false);
  });
});

describe("ChainMinersTable stale never-miner prune", () => {
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

  function stampedDescriptor(accountId: string, name: string, ts: number): NodeDescriptorRecord {
    return {
      accountId,
      blockTimestamp: ts,
      descriptor: { nodeName: name },
    } as unknown as NodeDescriptorRecord;
  }

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

  it("hides a zero-win miner idle 2+ weeks and notes the hidden count", () => {
    const staleTs = Math.floor((Date.now() - FOURTEEN_DAYS_MS - 86_400_000) / 1000);
    const recentTs = Math.floor((Date.now() - 86_400_000) / 1000);
    renderWith(
      [miner("5Stale"), miner("5Fresh")],
      [
        stampedDescriptor("5Stale", "stale-rig", staleTs),
        stampedDescriptor("5Fresh", "fresh-rig", recentTs),
      ],
    );
    const text = container.textContent ?? "";
    expect(text).toContain("fresh-rig");
    expect(text).not.toContain("stale-rig");
    // Header count reflects the visible (pruned) set, and the hidden ones are
    // disclosed rather than silently dropped.
    expect(text).toContain("On-chain miners (1)");
    expect(text).toContain("1 inactive never-miner");
  });

  it("shows an all-hidden message, not a bogus empty-search miss, when every miner is pruned", () => {
    const staleTs = Math.floor((Date.now() - FOURTEEN_DAYS_MS - 86_400_000) / 1000);
    renderWith(
      [miner("5StaleA"), miner("5StaleB")],
      [
        stampedDescriptor("5StaleA", "a-rig", staleTs),
        stampedDescriptor("5StaleB", "b-rig", staleTs),
      ],
    );
    const text = container.textContent ?? "";
    expect(text).toContain("On-chain miners (0)");
    expect(text).toContain("2 inactive never-miners");
    expect(text).toContain("All registered miners are inactive");
    // The user typed no query — never show a "no search results" message.
    expect(text).not.toContain("No miners match");
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

  // 5Old/5New carry a win (proofsWon "1") so the 2-week never-miner prune
  // (see isStaleNeverMiner) keeps them despite their ancient descriptor
  // timestamps; the sort assertions are about participation ordering, not the
  // prune. 5Never has no timestamp at all, so it is kept (unknown activity).
  const SORT_MINERS = [
    miner("5Never"),
    { ...miner("5Old"), deposit: "900", proofsWon: "1" },
    { ...miner("5New"), deposit: "100", proofsWon: "1" },
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
