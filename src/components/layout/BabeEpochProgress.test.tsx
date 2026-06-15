// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import { BabeEpochProgress } from "./BabeEpochProgress";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  // Reset store between tests so leakage doesn't make assertions flaky.
  useTelemetryStore.setState({ babeEpoch: null });
});

describe("BabeEpochProgress", () => {
  test("renders nothing when babeEpoch is null (REST-only deployment)", () => {
    useTelemetryStore.setState({ babeEpoch: null });
    act(() => {
      root.render(createElement(BabeEpochProgress));
    });
    expect(container.textContent).toBe("");
  });

  test("renders index, progress percent, and authority count", () => {
    useTelemetryStore.setState({
      babeEpoch: {
        epochIndex: 7,
        currentSlot: "16800",
        epochStartSlot: "14400",
        slotsPerEpoch: 2400,
        currentSlotInEpoch: 600, // 25%
        authorityCount: 3,
      },
    });
    act(() => {
      root.render(createElement(BabeEpochProgress));
    });
    expect(container.textContent).toContain("BABE #7");
    expect(container.textContent).toContain("25%");
    expect(container.textContent).toContain("3 authorities");
  });

  test("singular 'authority' for count=1", () => {
    useTelemetryStore.setState({
      babeEpoch: {
        epochIndex: 1,
        currentSlot: "0",
        epochStartSlot: "0",
        slotsPerEpoch: 2400,
        currentSlotInEpoch: 0,
        authorityCount: 1,
      },
    });
    act(() => {
      root.render(createElement(BabeEpochProgress));
    });
    expect(container.textContent).toContain("1 authority");
    expect(container.textContent).not.toContain("authorities");
  });

  test("clamps progress at 100% when currentSlotInEpoch > slotsPerEpoch", () => {
    // Defensive: if the chain rolls over between slot poll and authority
    // poll, currentSlotInEpoch could briefly exceed slotsPerEpoch.
    useTelemetryStore.setState({
      babeEpoch: {
        epochIndex: 7,
        currentSlot: "17000",
        epochStartSlot: "14400",
        slotsPerEpoch: 2400,
        currentSlotInEpoch: 2600,
        authorityCount: 3,
      },
    });
    act(() => {
      root.render(createElement(BabeEpochProgress));
    });
    expect(container.textContent).toContain("100%");
  });
});
