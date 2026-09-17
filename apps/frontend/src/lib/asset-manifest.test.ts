// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";

import {
  computeReachability,
  gzipSize,
  hrefToDistPath,
  parseInitialAssets,
  type Manifest,
} from "./asset-manifest";

describe("parseInitialAssets", () => {
  it("reads script, modulepreload, and stylesheet hrefs from index.html", () => {
    const html = `<!doctype html>
<html>
  <head>
    <script type="module" crossorigin src="/assets/index-aaa.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-aaa.css">
    <link rel="modulepreload" crossorigin href="/assets/vendor-bbb.js">
  </head>
  <body></body>
</html>`;
    expect(parseInitialAssets(html)).toEqual([
      { href: "/assets/index-aaa.js", rel: "script" },
      { href: "/assets/index-aaa.css", rel: "stylesheet" },
      { href: "/assets/vendor-bbb.js", rel: "modulepreload" },
    ]);
  });

  it("returns an empty list when the document has no asset tags", () => {
    expect(parseInitialAssets("<html><head></head></html>")).toEqual([]);
  });
});

describe("hrefToDistPath", () => {
  it("maps a root /assets href onto the dist directory", () => {
    expect(hrefToDistPath("/var/dist", "/assets/index-aaa.js")).toBe(
      "/var/dist/assets/index-aaa.js",
    );
  });
});

describe("gzipSize", () => {
  it("matches zlib gzip level 6", () => {
    const data = Buffer.from("hello dashboard assets");
    expect(gzipSize(data)).toBe(gzipSync(data, { level: 6 }).length);
  });
});

describe("computeReachability", () => {
  const manifest: Manifest = {
    "index.html": {
      file: "assets/index.js",
      name: "index",
      src: "index.html",
      isEntry: true,
      dynamicImports: ["src/views/Network.tsx", "src/views/Compute.tsx"],
      imports: ["_shared.js"],
      css: ["assets/index.css"],
    },
    "_shared.js": { file: "assets/shared.js", imports: ["index.html"] },
    "src/views/Network.tsx": {
      file: "assets/Network.js",
      name: "Network",
      src: "src/views/Network.tsx",
      isDynamicEntry: true,
      imports: ["index.html", "_nivo.js"],
    },
    "src/views/Compute.tsx": {
      file: "assets/Compute.js",
      name: "Compute",
      src: "src/views/Compute.tsx",
      isDynamicEntry: true,
      imports: ["index.html", "_nivo.js"],
    },
    "_nivo.js": { file: "assets/nivo.js", imports: ["index.html"] },
  };

  it("keeps the entry and its static import graph on the initial path", () => {
    const reach = computeReachability(manifest, "index.html");
    expect(reach.staticHrefs).toEqual(["/assets/index.js", "/assets/shared.js"]);
  });

  it("lists the entry's dynamic modules as the lazy boundary", () => {
    const reach = computeReachability(manifest, "index.html");
    expect(reach.dynamicModules).toEqual(["src/views/Network.tsx", "src/views/Compute.tsx"]);
  });

  it("resolves deferred graph reachable only behind the dynamic modules", () => {
    const reach = computeReachability(manifest, "index.html");
    expect(reach.deferred.map((d) => d.href).sort()).toEqual([
      "/assets/Compute.js",
      "/assets/Network.js",
      "/assets/nivo.js",
    ]);
    expect(reach.deferred.find((d) => d.module === "src/views/Network.tsx")?.href).toBe(
      "/assets/Network.js",
    );
    expect(reach.deferred.find((d) => d.href === "/assets/nivo.js")?.module).toBeUndefined();
  });
});
