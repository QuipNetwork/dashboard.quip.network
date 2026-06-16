// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { ValidatorAuthorshipRecord } from "@quip/shared/telemetry";

import { ChainView } from "./ChainView";

const validator = (overrides: Partial<ValidatorAuthorshipRecord>): ValidatorAuthorshipRecord => ({
  accountId: "5Auth",
  blocksAuthored: 0,
  blocksAuthoredWithPow: 0,
  lastAuthoredBlock: null,
  lastAuthoredAt: null,
  online: false,
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
  useTelemetryStore.setState({
    validators: [],
    serverTime: null,
  });
});

function getDataRows(): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll("tbody tr"));
}

describe("ChainView", () => {
  test("renders the Active Validators title", () => {
    useTelemetryStore.setState({
      validators: [validator({ accountId: "5Auth1", blocksAuthored: 1 })],
    });
    act(() => {
      root.render(createElement(ChainView));
    });
    expect(container.textContent).toContain("Active Validators (1)");
  });

  test("empty validators shows the chain-less hint and no table rows", () => {
    useTelemetryStore.setState({ validators: [] });
    act(() => {
      root.render(createElement(ChainView));
    });
    expect(container.textContent).toContain("QUIP_VALIDATOR_RPC_URLS");
    expect(getDataRows()).toHaveLength(0);
  });

  test("default sort is blocksAuthored DESC; clicking same header flips direction", () => {
    useTelemetryStore.setState({
      validators: [
        validator({ accountId: "5Low", blocksAuthored: 1 }),
        validator({ accountId: "5High", blocksAuthored: 10 }),
        validator({ accountId: "5Mid", blocksAuthored: 5 }),
      ],
    });
    act(() => {
      root.render(createElement(ChainView));
    });
    // Default DESC by blocksAuthored: high, mid, low.
    let rows = getDataRows();
    expect(rows[0]?.textContent).toContain("5High");
    expect(rows[1]?.textContent).toContain("5Mid");
    expect(rows[2]?.textContent).toContain("5Low");

    // Click the "Blocks Authored" header to flip ASC.
    const headers = container.querySelectorAll("thead th");
    const blocksHeader = Array.from(headers).find((h) =>
      h.textContent?.startsWith("Blocks Authored"),
    ) as HTMLElement | undefined;
    expect(blocksHeader).toBeDefined();
    act(() => {
      blocksHeader?.click();
    });
    rows = getDataRows();
    expect(rows[0]?.textContent).toContain("5Low");
    expect(rows[1]?.textContent).toContain("5Mid");
    expect(rows[2]?.textContent).toContain("5High");
  });

  test("online status renders a colored indicator for online vs offline", () => {
    useTelemetryStore.setState({
      validators: [
        validator({ accountId: "5OnlineAcct", online: true }),
        validator({ accountId: "5OfflineAcct", online: false }),
      ],
    });
    act(() => {
      root.render(createElement(ChainView));
    });
    const rows = getDataRows();
    // Account IDs are shortened in the table cell; query by title attribute
    // (set on the cell to expose the full SS58) to find the right row.
    const onlineRow = rows.find((r) => r.querySelector('[title="5OnlineAcct"]'));
    const offlineRow = rows.find((r) => r.querySelector('[title="5OfflineAcct"]'));
    expect(onlineRow?.textContent).toContain("● online");
    expect(offlineRow?.textContent).toContain("○ offline");
  });

  test("lastAuthoredAt=null surfaces an em dash in the Last Authored column", () => {
    useTelemetryStore.setState({
      validators: [
        validator({
          accountId: "5Idle",
          lastAuthoredBlock: null,
          lastAuthoredAt: null,
        }),
      ],
    });
    act(() => {
      root.render(createElement(ChainView));
    });
    const row = getDataRows()[0];
    // Em dash means "no head observed for this validator yet".
    expect(row?.textContent).toContain("—");
  });

  test("lastAuthoredAt populated renders 'Xs ago · #block'", () => {
    const serverTime = "2026-05-19T12:00:00Z";
    // 30 seconds before serverTime.
    const lastAuthoredAt = new Date(Date.parse(serverTime) - 30_000).toISOString();
    useTelemetryStore.setState({
      serverTime,
      validators: [
        validator({
          accountId: "5Recent",
          lastAuthoredBlock: "1234",
          lastAuthoredAt,
          online: true,
        }),
      ],
    });
    act(() => {
      root.render(createElement(ChainView));
    });
    const row = getDataRows()[0];
    expect(row?.textContent).toContain("30s ago");
    expect(row?.textContent).toContain("#1234");
  });
});
