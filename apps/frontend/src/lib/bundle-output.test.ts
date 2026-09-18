// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { computeReachability, distExists, loadManifest, measureBuild } from "./asset-manifest";

const DIST = join(import.meta.dir, "../../dist");

// Eager baseline on HEAD a587eed6dd1f3b62129083377cf39ebfbf421fe5:
// dist/assets/index-C8mmIdOD.js, zlib gzip level 6.
const BASELINE_INITIAL_JS_GZIP = 247_112;

// The two heavy views are the only dynamic imports of the entry.
const NETWORK_MODULE = "src/components/views/Network/NetworkView.tsx";
const COMPUTE_MODULE = "src/components/views/ComputeAvailable/ComputeAvailableView.tsx";

describe("frontend production bundle", () => {
  it("requires a Vite dist tree with an emitted manifest from bun run --filter @quip/frontend build", () => {
    expect(distExists(DIST)).toBe(true);
    expect(existsSync(join(DIST, ".vite", "manifest.json"))).toBe(true);
  });

  it("serves the HTML entry, CSS, and JS from /assets and keeps public fonts", () => {
    const measured = measureBuild(DIST);
    expect(measured.initialJs.length).toBeGreaterThan(0);
    expect(measured.initialJs.every((file) => file.href.startsWith("/assets/"))).toBe(true);
    expect(measured.css.every((file) => file.href.startsWith("/assets/"))).toBe(true);
    expect(measured.deferredChunks.every((chunk) => chunk.file.href.startsWith("/assets/"))).toBe(
      true,
    );
    expect(existsSync(join(DIST, "fonts"))).toBe(true);
    expect(readdirSync(join(DIST, "fonts")).length).toBe(13);
  });

  it("moves the chart/map views out of the entry and shrinks initial gzip JS", () => {
    const measured = measureBuild(DIST);
    const reach = computeReachability(loadManifest(DIST), "index.html");

    // The entry owns the heavy views as dynamic imports, not as static imports.
    expect(reach.dynamicModules).toEqual([NETWORK_MODULE, COMPUTE_MODULE]);

    // Graph reachability: the two heavy views must resolve to deferred output chunks.
    const deferredBySrc = new Map(
      reach.deferred.filter((d) => d.module !== undefined).map((d) => [d.module as string, d.href]),
    );
    expect(deferredBySrc.get(NETWORK_MODULE)).toBeDefined();
    expect(deferredBySrc.get(COMPUTE_MODULE)).toBeDefined();

    // The resolved deferred chunks are present on disk and not part of initial JS.
    const initialHrefs = new Set(measured.initialJs.map((f) => f.href));
    for (const chunk of measured.deferredChunks) {
      expect(chunk.file.href.startsWith("/assets/")).toBe(true);
      expect(initialHrefs.has(chunk.file.href)).toBe(false);
    }

    // Measured reduction over the eager baseline.
    expect(measured.initialJsGzip).toBeLessThan(BASELINE_INITIAL_JS_GZIP);
    expect(measured.initialJsGzip).toBeLessThan(measured.allJsGzip);
  });

  it("keeps @polkadot out of every JS asset", () => {
    const measured = measureBuild(DIST);
    expect(measured.polkadotFiles).toEqual([]);
  });
});
