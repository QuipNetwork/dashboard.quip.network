// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { QPU_RESERVED_SECONDS_PER_QBLOCK } from "@quip/shared/telemetry";

import { EnergyPerQblockCard } from "./EnergyPerQblockCard";

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
    expect(note).toContain(`${QPU_SYSTEM_WATTS / 1000} kW`);
    expect(note).toContain(`${QPU_RESERVED_SECONDS_PER_QBLOCK}-second reserved window`);
  });

  test("shows the empty state and a zero total when the window has no qblocks", async () => {
    render({ ...idleTelemetryClient, fetchMiningHistory: async (since) => ({ since, rows: [] }) });
    await settle();
    expect(container.textContent).toContain("No qblocks in this range yet");
    expect(container.textContent).toContain("0 J in range");
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
      fetchMiningHistory: async (since) => ({
        since,
        rows: [
          {
            qblockId: "1",
            substrateBlockNumber: "1",
            timestamp: 1_751_457_001,
            minerId: "Q",
            miningTime: 0,
          },
        ],
      }),
    });
    await settle();
    // 12 kW × 60 s = 720 kJ.
    expect(container.textContent).toContain("720.0 kJ in range");
  });
});
