import { JSDOM } from "jsdom";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});

Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: dom.window.HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "MutationObserver", {
  value: dom.window.MutationObserver,
  configurable: true,
});
Object.defineProperty(globalThis, "SVGElement", {
  value: dom.window.SVGElement,
  configurable: true,
});
Object.defineProperty(globalThis, "getComputedStyle", {
  value: dom.window.getComputedStyle,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  value: (id: number) => clearTimeout(id),
  configurable: true,
});
Object.defineProperty(globalThis, "ResizeObserver", {
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  configurable: true,
});

// `react-simple-maps` fetches a world atlas from unpkg inside an effect, so
// any test rendering the node map made a real network request to a
// third-party CDN. Serve an empty but valid topology instead: the map
// renders zero country paths, which no assertion depends on.
const EMPTY_TOPOLOGY = {
  type: "Topology",
  arcs: [],
  objects: { countries: { type: "GeometryCollection", geometries: [] } },
};
const realFetch = globalThis.fetch;
Object.defineProperty(globalThis, "fetch", {
  value: (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (String(input).includes("world-atlas")) {
      return Promise.resolve(new Response(JSON.stringify(EMPTY_TOPOLOGY), { status: 200 }));
    }
    return realFetch(input as never, init);
  },
  configurable: true,
});
