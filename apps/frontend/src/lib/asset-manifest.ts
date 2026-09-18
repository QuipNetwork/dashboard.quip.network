// SPDX-License-Identifier: AGPL-3.0-or-later

import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type InitialAssetRel = "script" | "modulepreload" | "stylesheet";

export interface AssetRef {
  href: string;
  rel: InitialAssetRel;
}

export interface FileMeasure {
  path: string;
  href: string;
  rawBytes: number;
  gzipBytes: number;
}

export interface ManifestChunk {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

export interface DeferredChunk {
  /** Original module id Vite attributed, where known (dynamic view entries). */
  module: string | undefined;
  file: FileMeasure;
}

export interface Reachability {
  /** Output files the entry downloads up front (entry chunk plus its static import graph). */
  staticHrefs: string[];
  /** Output files reachable only by following dynamic imports from the entry. */
  deferred: { module: string | undefined; href: string }[];
  /** Original module ids Vite lists as dynamic imports of the entry. */
  dynamicModules: string[];
}

export interface BuildMeasure {
  initialJs: FileMeasure[];
  css: FileMeasure[];
  deferredChunks: DeferredChunk[];
  initialJsRaw: number;
  initialJsGzip: number;
  allJsGzip: number;
  polkadotFiles: string[];
}

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const SRC_ATTR = /\bsrc="([^"]+)"/i;
const HREF_ATTR = /\bhref="([^"]+)"/i;
const REL_ATTR = /\brel="([^"]+)"/i;

export function parseInitialAssets(html: string): AssetRef[] {
  const out: AssetRef[] = [];
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const src = match[0].match(SRC_ATTR)?.[1];
    if (src) out.push({ href: src, rel: "script" });
  }
  for (const match of html.matchAll(LINK_TAG)) {
    const tag = match[0];
    const href = tag.match(HREF_ATTR)?.[1];
    const rel = tag.match(REL_ATTR)?.[1];
    if (href && rel === "stylesheet") out.push({ href, rel: "stylesheet" });
    if (href && rel === "modulepreload") out.push({ href, rel: "modulepreload" });
  }
  return out;
}

export function hrefToDistPath(distDir: string, href: string): string {
  return join(distDir, href.replace(/^\//, ""));
}

export function gzipSize(data: Uint8Array): number {
  return gzipSync(data, { level: 6 }).length;
}

export function loadManifest(distDir: string): Manifest {
  const manifestPath = join(distDir, ".vite", "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

/**
 * Compute what the entry downloads up front versus what is deferred behind
 * Vite dynamic imports, from the emitted `.vite/manifest.json`. This asserts
 * graph reachability from the module graph instead of scanning minified JS
 * for library names (which produces false positives from Vite chunk naming).
 */
export function computeReachability(manifest: Manifest, entryKey: string): Reachability {
  const fileOf = (id: string) => manifest[id]?.file ?? "";

  const reachable = (roots: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const imp of manifest[id]?.imports ?? []) stack.push(imp);
    }
    return seen;
  };

  const entry = manifest[entryKey];
  const dynamicModules = [...(entry?.dynamicImports ?? [])];
  const staticIds = reachable([entryKey]);
  const deferredIds = [...reachable(dynamicModules)].filter((id) => !staticIds.has(id));

  const normalize = (href: string) => (href.startsWith("/") ? href : `/${href}`);

  return {
    staticHrefs: [...staticIds].map(fileOf).filter(Boolean).map(normalize),
    deferred: deferredIds.map((id) => ({ module: manifest[id]?.src, href: normalize(fileOf(id)) })),
    dynamicModules,
  };
}

export function listAssetJsFiles(distDir: string): string[] {
  const assetsDir = join(distDir, "assets");
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(assetsDir, name));
}

function measureFile(distDir: string, absPath: string): FileMeasure {
  const data = readFileSync(absPath);
  const rel = absPath.slice(distDir.length).replace(/\\/g, "/");
  const href = rel.startsWith("/") ? rel : `/${rel}`;
  return {
    path: absPath,
    href,
    rawBytes: data.byteLength,
    gzipBytes: gzipSize(data),
  };
}

function sum(files: FileMeasure[], key: "rawBytes" | "gzipBytes"): number {
  return files.reduce((total, file) => total + file[key], 0);
}

export function measureBuild(distDir: string): BuildMeasure {
  const root = distDir.replace(/\/$/, "");
  const html = readFileSync(join(root, "index.html"), "utf8");
  const initial = parseInitialAssets(html);
  const initialJsHrefs = new Set(
    initial
      .filter((asset) => asset.rel === "script" || asset.rel === "modulepreload")
      .map((a) => a.href),
  );

  const initialJs = [...initialJsHrefs].map((href) =>
    measureFile(root, hrefToDistPath(root, href)),
  );
  const css = initial
    .filter((asset) => asset.rel === "stylesheet")
    .map((href) => hrefToDistPath(root, href.href))
    .filter((p) => existsSync(p))
    .map((p) => measureFile(root, p));

  const reach = computeReachability(loadManifest(root), "index.html");
  const deferredChunks = reach.deferred
    .filter((d) => d.href && !initialJsHrefs.has(d.href))
    .map((d) => {
      const file = measureFile(root, hrefToDistPath(root, d.href));
      return existsSync(file.path) ? { module: d.module, file } : null;
    })
    .filter((d): d is DeferredChunk => d !== null);

  const allJs = listAssetJsFiles(root).map((absPath) => measureFile(root, absPath));
  const polkadotFiles = allJs
    .filter((file) => readFileSync(file.path, "utf8").includes("@polkadot"))
    .map((file) => file.href);

  return {
    initialJs,
    css,
    deferredChunks,
    initialJsRaw: sum(initialJs, "rawBytes"),
    initialJsGzip: sum(initialJs, "gzipBytes"),
    allJsGzip: sum(allJs, "gzipBytes"),
    polkadotFiles,
  };
}

export function readJoinedSources(files: FileMeasure[]): string {
  return files.map((file) => readFileSync(file.path, "utf8")).join("\n");
}

export function distExists(distDir: string): boolean {
  return existsSync(join(distDir, "index.html")) && statSync(join(distDir, "index.html")).isFile();
}
