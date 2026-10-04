import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { uiStore } from "@/store/ui-store";
import { useNodeUrlSync } from "./use-node-url-sync";

let container: HTMLDivElement;
let root: Root;
let canonical: HTMLLinkElement;

function NodeUrlSync() {
  useNodeUrlSync();
  return null;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  uiStore.setState(uiStore.getInitialState());
  canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = "https://dashboard.quip.network/";
  document.head.appendChild(canonical);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  canonical.remove();
  window.history.replaceState(null, "", "/");
  uiStore.setState(uiStore.getInitialState());
});

test("node selection updates the canonical and clearing it restores the home URL", () => {
  act(() => root.render(<NodeUrlSync />));
  act(() => uiStore.getState().openNode("5GrwvaEF"));
  expect(canonical.href).toBe("https://dashboard.quip.network/?node=5GrwvaEF");
  expect(window.location.search).toBe("?node=5GrwvaEF");

  act(() => uiStore.getState().setViewMode("network"));
  expect(canonical.href).toBe("https://dashboard.quip.network/");
  expect(window.location.search).toBe("");
});

test("opening a shared node URL gives it its own canonical", () => {
  window.history.replaceState(null, "", "/?node=5GrwvaEF");
  act(() => root.render(<NodeUrlSync />));
  expect(canonical.href).toBe("https://dashboard.quip.network/?node=5GrwvaEF");
  expect(uiStore.getState().selectedNodeId).toBe("5GrwvaEF");
});

test("history navigation restores the canonical for the selected node", () => {
  act(() => root.render(<NodeUrlSync />));
  act(() => {
    window.history.replaceState(null, "", "/?node=5FHneW46");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  expect(canonical.href).toBe("https://dashboard.quip.network/?node=5FHneW46");
});
