#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Build a workload profile for the matched benchmark. The chain fixture
// records the real upstream method sequence (chain_getBlock, state_getMetadata,
// etc.) and byte sizes from a captured valid block. The seed records the
// miner-REST upstream rules. Together they describe the recorded upstream
// work for the matched comparison.
//
// This is the honest basis for the upstream-call and byte comparison. The
// validator upstream comparison uses the chain-provenance RPC method calls
// only; the miner-REST rules are local HTTP requests to the miner and are
// recorded separately, not counted as validator upstream calls. That keeps
// totals.calls consistent with the validator upstream counters.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const out = {
    fixtures: join(ROOT, "scripts/benchmark/testdata/fixtures"),
    out: "build/workload.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--fixtures" && next) {
      out.fixtures = next;
      i += 1;
    } else if (a === "--out" && next) {
      out.out = next;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/benchmark/workload.mjs --fixtures DIR --out FILE\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function bytesOf(file) {
  return file.endsWith(".json") ? JSON.stringify(file).length : 0;
}

export function buildWorkload(provenance, seed) {
  if (!provenance || typeof provenance !== "object") {
    throw new Error("provenance must be a parsed JSON object");
  }
  if (!Array.isArray(provenance.calls) || provenance.calls.length === 0) {
    throw new Error("provenance.calls must be a non-empty array");
  }

  // Validator upstream RPC calls from the recorded chain provenance.
  const chainCalls = provenance.calls.map((c) => ({
    method: c.method,
    params: c.params ?? [],
    responseBytes:
      typeof c.responseBytes === "number" ? c.responseBytes : bytesOf(c),
    clientBytes:
      typeof c.clientBytes === "number"
        ? c.clientBytes
        : 32 + (c.params ?? []).length * 4,
  }));

  // Miner-REST upstream rules from the seed. These are local HTTP requests
  // to the miner, recorded separately, not counted as validator upstream
  // calls.
  const restRules = Array.isArray(seed?.upstream) ? seed.upstream : [];
  const restCalls = restRules.map((rule, index) => {
    const body = JSON.stringify(rule.body ?? null);
    return {
      index,
      method: `rest_${rule.path ?? "/"}`,
      params: rule.query ?? {},
      responseBytes: body.length,
      clientBytes: body.length,
    };
  });

  const totalResponseBytes = chainCalls.reduce((n, m) => n + m.responseBytes, 0);
  const totalCallBytes = chainCalls.reduce((n, m) => n + m.clientBytes, 0);
  const restResponseBytes = restCalls.reduce((n, m) => n + m.responseBytes, 0);

  return {
    formatVersion: 3,
    derivedFrom: "chain-live/provenance.json + seed.json upstream rules",
    blockHeight: provenance.blockNumber,
    finalizedHash: provenance.finalizedHash,
    metadataBytes: provenance.metadataBytes,
    eventsBytes: provenance.eventsBytes,
    blockBytes: provenance.blockBytes ?? 29400,
    rpcCount: provenance.rpcCount ?? chainCalls.length,
    recordedElapsedSeconds: provenance.elapsedSeconds ?? null,
    calls: chainCalls,
    numRpcCalls: chainCalls.length,
    minerRestCalls: restCalls,
    totals: {
      // Validator upstream comparison baseline: RPC method calls only.
      calls: chainCalls.length,
      responseBytes: totalResponseBytes,
      callBytes: totalCallBytes,
      // Separately-reported miner REST volumes.
      minerRestCalls: restCalls.length,
      minerRestResponseBytes: restResponseBytes,
      // A block cadence of 6 seconds drives the replay frequency.
      blocksPerSecond: 1 / 6,
    },
  };
}

export async function loadProvenance(chainDir) {
  const path = join(chainDir, "provenance.json");
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fixturesDir = resolve(opts.fixtures);
  const provenance = await loadProvenance(join(fixturesDir, "chain-live"));
  let seed = {};
  try {
    seed = JSON.parse(await readFile(join(fixturesDir, "seed.json"), "utf8"));
  } catch {
    // No seed present; the chain provenance alone is the recorded work.
  }
  const workload = buildWorkload(provenance, seed);
  const outPath = resolve(opts.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(workload, null, 2)}\n`);
  process.stdout.write(
    `wrote upstream workload: ${workload.totals.calls} validator calls, ` +
      `${workload.totals.responseBytes} response bytes, ` +
      `${workload.totals.minerRestCalls} miner REST calls, ` +
      `${workload.totals.minerRestResponseBytes} miner REST bytes -> ${outPath}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
