// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression test for audit fix #1 (tab visibility heartbeat). The
// audit's concern: on visibility-restore after a long hidden period,
// the user sees stale data until the next natural poll. Combined fix
// (already landed):
//
//   - App.tsx's onVisibility handler immediately calls tick() on
//     transition-to-visible, kicking a fetch independent of the
//     setInterval cadence.
//   - The SyncIndicator anchors ages on serverTime (audit #3, Phase 1),
//     so the brief window between resume and fetch-completion doesn't
//     show false "Indexer offline" flashes.
//
// This test asserts the visibility handler's immediate-fetch contract.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "./store/telemetry-store";

let container: HTMLDivElement;
let root: Root;
let visibility: "visible" | "hidden" = "visible";

function dispatchVisibilityChange() {
  // jsdom is strict about Event-class identity — use the window's Event
  // constructor (the same one jsdom validates against) rather than the
  // global one Bun exposes.
  const W = globalThis as unknown as { window?: { Event: typeof Event } };
  const EventCtor = W.window?.Event ?? Event;
  document.dispatchEvent(new EventCtor("visibilitychange"));
}

function setVisibility(state: "visible" | "hidden") {
  visibility = state;
  dispatchVisibilityChange();
}

let originalFetchTelemetry: (typeof useTelemetryStore.getState)["fetchTelemetry"] | null = null;

beforeEach(() => {
  visibility = "visible";
  // jsdom's document.visibilityState is read-only; intercept via getter.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Snapshot the real fetchTelemetry so afterEach can restore it. Tests
  // here swap it for a counter-spy; leaking the spy into other test
  // files crashes their App smoke tests (they expect /api/telemetry to
  // actually fire).
  originalFetchTelemetry = useTelemetryStore.getState().fetchTelemetry;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({
    blocks: [],
    nodes: null,
    ...(originalFetchTelemetry ? { fetchTelemetry: originalFetchTelemetry } : {}),
  });
  originalFetchTelemetry = null;
  // Drop the visibilityState shadow so it doesn't pollute other test files.
  delete (document as unknown as { visibilityState?: string }).visibilityState;
});

describe("App visibility fetch behavior (audit #1)", () => {
  test("fires fetch immediately on mount when visible", async () => {
    let fetchCount = 0;
    spyOn(useTelemetryStore.getState(), "fetchTelemetry").mockImplementation(async () => {
      fetchCount++;
    });
    // Re-set the state with our spy to make sure the store reference
    // captured by App.tsx uses it.
    useTelemetryStore.setState({
      fetchTelemetry: async () => {
        fetchCount++;
      },
    });

    const App = (await import("./App")).default;
    await act(async () => {
      root.render(createElement(App));
    });
    expect(fetchCount).toBeGreaterThanOrEqual(1);
  });

  test("fires fetch immediately on visibility-restore (does not wait for poll interval)", async () => {
    let fetchCount = 0;
    useTelemetryStore.setState({
      fetchTelemetry: async () => {
        fetchCount++;
      },
    });

    const App = (await import("./App")).default;
    await act(async () => {
      root.render(createElement(App));
    });
    const onMount = fetchCount;

    // Tab away.
    setVisibility("hidden");
    await act(async () => {
      // flush the visibilitychange handler synchronously.
    });

    // While hidden, no additional fetches.
    const afterHide = fetchCount;
    expect(afterHide).toBe(onMount);

    // Return to visible. The handler must trigger another fetch.
    setVisibility("visible");
    await act(async () => {
      // Microtasks flush the handler's synchronous fetchTelemetry call.
    });
    expect(fetchCount).toBeGreaterThan(afterHide);
  });
});
