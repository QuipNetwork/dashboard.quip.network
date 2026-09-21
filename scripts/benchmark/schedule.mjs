#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Generate a deterministic, recorded HTTP schedule from a dashboard contract
// manifest. The same schedule is replayed against the baseline and the new
// backend so both sides receive identical request inputs and timings.
//
// Usage:
//   node scripts/benchmark/schedule.mjs \
//     --fixtures ./crates/quip-dashboard/tests/fixtures \
//     --manifest manifest.json \
//     --rate 5 --duration 30 \
//     --out build/schedule.json
//
// The output records one entry per request with an absolute offset in
// milliseconds. A fixed seed keeps a given manifest/rate/duration pair
// byte-identical across runs, which is what makes the comparison matched.

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const out = {
    rate: 5,
    duration: 30,
    seed: 20260916,
    manifest: "manifest.json",
    out: "build/schedule.json",
    fixtures: join(ROOT, "scripts/benchmark/testdata/fixtures"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const set = (k) => {
      if (!next && !["--help", "-h"].includes(a)) throw new Error(`${a} requires a value`);
      out[k] = next ?? true;
      i += 1;
    };
    if (a === "--fixtures") set("fixtures");
    else if (a === "--manifest") set("manifest");
    else if (a === "--rate") set("rate");
    else if (a === "--duration") set("duration");
    else if (a === "--seed") set("seed");
    else if (a === "--out") set("out");
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/benchmark/schedule.mjs [flags]",
          "",
          "  --fixtures DIR  fixture directory containing manifest.json",
          "  --manifest FILE manifest file name inside the fixture directory",
          "  --rate N        target requests per second (default 5)",
          "  --duration N    schedule length in seconds (default 30)",
          "  --seed N        PRNG seed for deterministic ordering (default 20260916)",
          "  --out FILE      output schedule JSON path",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

// Deterministic PRNG (mulberry32) so ordering is reproducible from the seed.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function generateSchedule(opts) {
  const fixtures = resolve(opts.fixtures);
  const manifestPath = join(fixtures, opts.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error(`manifest ${manifestPath} is not a non-empty array of captures`);
  }

  const rate = Number(opts.rate);
  const duration = Number(opts.duration);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("rate must be a positive number");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("duration must be positive");

  const prand = mulberry32(Number(opts.seed) >>> 0);
  const total = Math.ceil(duration * rate);
  // Weight populated captures higher to model a populated steady state.
  const weighted = manifest.flatMap((entry) => {
    const w = entry.scenario === "empty" ? 2 : entry.scenario === "populated" ? 5 : 1;
    return Array(w).fill(entry);
  });

  const requests = [];
  for (let i = 0; i < total; i++) {
    const entry = weighted[Math.floor(prand() * weighted.length)];
    const tOffsetMs = Math.round((i / rate) * 1000);
    requests.push({
      tOffsetMs,
      method: entry.method,
      path: entry.path,
      name: entry.name,
      status: entry.status,
      scenario: entry.scenario,
    });
  }
  requests.sort((a, b) => a.tOffsetMs - b.tOffsetMs);

  const digest = createHash("sha256")
    .update(JSON.stringify({ manifest: manifestPath, rate, duration, seed: opts.seed }))
    .digest("hex")
    .slice(0, 16);

  return {
    formatVersion: 1,
    generatedFrom: manifestPath,
    rate,
    durationSeconds: duration,
    totalRequests: requests.length,
    seed: opts.seed,
    scheduleHash: digest,
    generatedAtUtc: new Date().toISOString(),
    requests,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.fixtures = resolve(opts.fixtures);
  const schedule = await generateSchedule(opts);
  const outPath = resolve(opts.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(schedule, null, 2)}\n`);
  process.stdout.write(
    `wrote ${schedule.totalRequests} requests over ${opts.duration}s to ${outPath} (hash ${schedule.scheduleHash})\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
