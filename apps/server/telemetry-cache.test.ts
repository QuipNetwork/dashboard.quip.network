// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { newInMemoryAdapter } from "@quip/core/test-helpers";
import type { BlockRecord, TelemetryResponse } from "@quip/shared/telemetry";
import { createApp } from "./app";

// Wrap the real adapter so we can count read calls and optionally inject
// per-call latency — the two levers we need to quantify what the snapshot
// cache saves. Every adapter method is async, so a uniform async shim is safe.
interface Instrumented {
  db: DatabaseAdapter;
  calls: () => number;
  reset: () => void;
}

function instrument(inner: DatabaseAdapter, opts: { delayMs?: number } = {}): Instrumented {
  let count = 0;
  const db = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        count += 1;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as DatabaseAdapter;
  return { db, calls: () => count, reset: () => (count = 0) };
}

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xpow1",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xsub1",
    substrateParentHash: "0xsub0",
    timestamp: 1_700_000_000,
    minerId: "5GPP",
    energy: -2510,
    diversity: 0.42,
    numValidSolutions: 5,
    miningTime: 6,
    reward: "1000000000000",
    nonce: "42",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -2500,
    minDiversity: 0.2,
    minSolutions: 5,
    finalized: false,
    ...overrides,
  };
}

const TELEMETRY = new Request("http://test/api/telemetry");
const fetchTelemetry = async (app: ReturnType<typeof createApp>): Promise<TelemetryResponse> => {
  const res = await app.fetch(TELEMETRY);
  expect(res.status).toBe(200);
  return (await res.json()) as TelemetryResponse;
};

let inner: DatabaseAdapter;

beforeEach(async () => {
  inner = await newInMemoryAdapter();
  await inner.insertBlock(makeBlock());
});

afterEach(async () => {
  await inner.disconnect();
});

describe("telemetry snapshot cache", () => {
  test("serves a cached snapshot within the TTL without re-querying the DB", async () => {
    const inst = instrument(inner);
    let clock = 1000;
    const app = createApp({
      db: inst.db,
      validatorRpcUrls: ["ws://test:9944"],
      enableStatic: false,
      now: () => clock,
      telemetryCacheTtlMs: 1000,
    });

    const first = await fetchTelemetry(app);
    const afterBuild = inst.calls();
    expect(afterBuild).toBeGreaterThan(0);

    clock = 1500; // still within the 1000ms TTL window
    const second = await fetchTelemetry(app);

    expect(inst.calls()).toBe(afterBuild); // no extra DB work
    expect(second).toEqual(first); // identical payload
  });

  test("rebuilds the snapshot after the TTL expires", async () => {
    const inst = instrument(inner);
    let clock = 1000;
    const app = createApp({
      db: inst.db,
      validatorRpcUrls: ["ws://test:9944"],
      enableStatic: false,
      now: () => clock,
      telemetryCacheTtlMs: 1000,
    });

    await fetchTelemetry(app);
    const afterBuild = inst.calls();

    clock = 2001; // past the TTL → fresh build
    await fetchTelemetry(app);
    expect(inst.calls()).toBeGreaterThan(afterBuild);
  });

  test("dedupes concurrent rebuilds into a single DB build (singleflight)", async () => {
    // Latency widens the build window so all concurrent callers arrive before
    // the first build resolves — the worst case for a naive per-request path.
    const inst = instrument(inner, { delayMs: 5 });
    const app = createApp({
      db: inst.db,
      validatorRpcUrls: ["ws://test:9944"],
      enableStatic: false,
      now: () => 1000,
      telemetryCacheTtlMs: 1000,
    });

    const concurrent = 50;
    const bodies = await Promise.all(Array.from({ length: concurrent }, () => fetchTelemetry(app)));

    // One build's worth of calls served all 50 requests.
    const oneBuild = inst.calls();
    bodies.forEach((b) => expect(b).toEqual(bodies[0]!));

    // Sanity: a single uncached build is far cheaper than 50 of them.
    const baseline = instrument(inner);
    const uncached = createApp({
      db: baseline.db,
      validatorRpcUrls: ["ws://test:9944"],
      enableStatic: false,
      now: () => 1000,
      telemetryCacheTtlMs: 0,
    });
    await fetchTelemetry(uncached);
    const perBuild = baseline.calls();
    expect(oneBuild).toBeLessThanOrEqual(perBuild);
  });

  test("STRESS: cache eliminates per-request recompute under repeated polling", async () => {
    const REQUESTS = 100;
    const DELAY_MS = 1;

    // Baseline: TTL=0 forces every request to rebuild (the pre-cache behaviour).
    const baseline = instrument(inner, { delayMs: DELAY_MS });
    let bClock = 1000;
    const uncached = createApp({
      db: baseline.db,
      validatorRpcUrls: ["ws://test:9944"],
      enableStatic: false,
      now: () => bClock,
      telemetryCacheTtlMs: 0,
    });
    const tUncached0 = performance.now();
    for (let i = 0; i < REQUESTS; i++) {
      bClock += 1;
      await fetchTelemetry(uncached);
    }
    const uncachedMs = performance.now() - tUncached0;
    const uncachedCalls = baseline.calls();

    // Cached: a fixed clock keeps every request inside one TTL window.
    const cached = instrument(inner, { delayMs: DELAY_MS });
    const withCache = createApp({
      db: cached.db,
      validatorRpcUrls: ["ws://test:9944"],
      enableStatic: false,
      now: () => 1000,
      telemetryCacheTtlMs: 1000,
    });
    const tCached0 = performance.now();
    for (let i = 0; i < REQUESTS; i++) await fetchTelemetry(withCache);
    const cachedMs = performance.now() - tCached0;
    const cachedCalls = cached.calls();

    const callRatio = uncachedCalls / cachedCalls;
    console.log(
      `[stress] ${REQUESTS} telemetry requests @ ${DELAY_MS}ms/query:\n` +
        `  DB calls : uncached=${uncachedCalls}  cached=${cachedCalls}  (${callRatio.toFixed(1)}x fewer)\n` +
        `  wallclock: uncached=${uncachedMs.toFixed(0)}ms  cached=${cachedMs.toFixed(0)}ms  ` +
        `(${(uncachedMs / Math.max(cachedMs, 0.01)).toFixed(1)}x faster)`,
    );

    // The cache should do exactly one build regardless of request count.
    expect(cachedCalls).toBe(uncachedCalls / REQUESTS);
    expect(callRatio).toBeGreaterThanOrEqual(REQUESTS - 1);
    expect(cachedMs).toBeLessThan(uncachedMs);
  });
});
