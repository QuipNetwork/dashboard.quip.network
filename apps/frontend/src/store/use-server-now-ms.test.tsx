// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression guard for bead mrt: resolving server-anchored "now" must never
// destabilise a zustand snapshot. The old `selectServerNowMs` selector called
// `Date.now()` inside the store selector, so `useTelemetryStore(selectServerNowMs)`
// returned a fresh number every render and looped `useSyncExternalStore`
// ("Maximum update depth exceeded") whenever `serverTime` was null. The hook
// subscribes to the stable `serverTime` string and resolves now in the hook
// body, so a null serverTime renders cleanly.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { resolveServerNowMs, useServerNowMs, useTelemetryStore } from "./telemetry-store";

describe("resolveServerNowMs", () => {
  it("parses serverTime when present", () => {
    const iso = "2026-05-19T12:00:00Z";
    expect(resolveServerNowMs(iso)).toBe(Date.parse(iso));
  });

  it("falls back to Date.now() when serverTime is null", () => {
    const before = Date.now();
    const got = resolveServerNowMs(null);
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });
});

describe("useServerNowMs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: number | null = null;

  function Probe(): null {
    seen = useServerNowMs();
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seen = null;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useTelemetryStore.setState({ serverTime: null });
  });

  it("renders without looping when serverTime is null", () => {
    useTelemetryStore.setState({ serverTime: null });
    const before = Date.now();
    // Would throw "Maximum update depth exceeded" if now leaked through the
    // store snapshot; a clean render proves the subscription is stable.
    act(() => root.render(createElement(Probe)));
    expect(seen).not.toBeNull();
    expect(seen!).toBeGreaterThanOrEqual(before);
  });

  it("returns the parsed serverTime once a response has landed", () => {
    const iso = "2026-05-19T12:00:00Z";
    useTelemetryStore.setState({ serverTime: iso });
    act(() => root.render(createElement(Probe)));
    expect(seen).toBe(Date.parse(iso));
  });
});
