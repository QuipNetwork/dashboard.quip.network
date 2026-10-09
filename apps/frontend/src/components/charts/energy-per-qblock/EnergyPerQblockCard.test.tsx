// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { formatJoules } from "@/lib/format";
import { estimateDeviceWatts, QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { QPU_RESERVED_SECONDS_PER_QBLOCK, type MiningHistoryRow } from "@quip/shared/telemetry";

import { EnergyPerQblockCard } from "./EnergyPerQblockCard";

const historyRows: MiningHistoryRow[] = [
  {
    qblockId: "1",
    substrateBlockNumber: "1",
    timestamp: 1_751_457_001,
    minerId: "Q",
    miningTime: 0,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ participationCompute: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ participationCompute: [] });
});

function render(client: TelemetryClient): void {
  act(() => {
    root.render(
      createElement(ServicesProvider, { client, children: createElement(EnergyPerQblockCard) }),
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("EnergyPerQblockCard", () => {
  test("states the measurement basis from the constants it uses", async () => {
    render({ ...idleTelemetryClient, fetchMiningHistory: async (since) => ({ since, rows: [] }) });
    await settle();
    const note = container.querySelector('[data-qa="energy-basis"]')?.textContent ?? "";
    expect(note).toContain("Power is a rate in watts");
    expect(note).toContain("Energy is power × time");
    expect(note).toContain(`CPU ${estimateDeviceWatts("CPU", null)} W`);
    expect(note).toContain(`GPU ${estimateDeviceWatts("GPU", null)} W`);
    expect(note).toContain(`other ${estimateDeviceWatts("OTHER", null)} W`);
    expect(note).toContain(`${QPU_SYSTEM_WATTS / 1000} kW`);
    expect(note).toContain(
      `capped at its ${QPU_RESERVED_SECONDS_PER_QBLOCK}-second reserved window`,
    );
    expect(note).not.toContain("TDP");
  });

  test("shows the empty state and a zero total when the window has no qblocks", async () => {
    render({ ...idleTelemetryClient, fetchMiningHistory: async (since) => ({ since, rows: [] }) });
    await settle();
    expect(container.textContent).toContain("No energy estimates in this range yet");
    expect(container.textContent).toContain("0 J in range");
  });

  test("shows no energy estimates when history has qblocks without participation data", async () => {
    render({
      ...idleTelemetryClient,
      fetchMiningHistory: async (since) => ({ since, rows: historyRows }),
    });
    await settle();
    expect(container.textContent).toContain("No energy estimates in this range yet");
    expect(container.textContent).toContain("0 J in range");
    expect(container.querySelector('[data-qa="chart-energy-per-qblock"]')).toBeNull();
  });

  test("totals the window in the subtitle", async () => {
    useTelemetryStore.setState({
      participationCompute: [
        {
          qblockId: "1",
          account: "Q",
          kind: "QpuDwave",
          miningSeconds: 300,
          exactQpuAccessUs: null,
        },
      ],
    });
    render({
      ...idleTelemetryClient,
      fetchMiningHistory: async (since) => ({ since, rows: historyRows }),
    });
    await settle();
    // 12 kW × 60 s = 720 kJ.
    expect(container.textContent).toContain("720.0 kJ in range");
  });

  test("replaces retained estimates with an error and hides the total after a range fetch fails", async () => {
    useTelemetryStore.setState({
      participationCompute: [
        {
          qblockId: "1",
          account: "Q",
          kind: "QpuDwave",
          miningSeconds: 300,
          exactQpuAccessUs: null,
        },
      ],
    });
    let failFetch = false;
    render({
      ...idleTelemetryClient,
      fetchMiningHistory: async (since) => {
        if (failFetch) throw new Error("Range request failed");
        return { since, rows: historyRows };
      },
    });
    await settle();
    expect(container.querySelector('[data-qa="chart-energy-per-qblock"]')).not.toBeNull();
    expect(container.textContent).toContain(
      `${formatJoules(QPU_SYSTEM_WATTS * QPU_RESERVED_SECONDS_PER_QBLOCK)} in range`,
    );

    failFetch = true;
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Energy range"] button'),
    ).find((b) => b.textContent === "1H")!;
    act(() => button.click());
    await settle();

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Mining history unavailable: Range request failed");
    expect(container.querySelector('[data-qa="chart-energy-per-qblock"]')).toBeNull();
    expect(container.textContent).not.toContain("in range");
  });
});
