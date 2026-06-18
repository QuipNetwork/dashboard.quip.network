// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { MiningSubmissionNotFoundError } from "@quip/core/miner-api";

import { DbChainStateReader } from "../chain-state";
import type { MinerSource } from "../client";
import { IndexerState } from "../state";
import { makeConfig, newInMemoryAdapter } from "../test-helpers";
import { TipWorker, type TipWorkerDeps } from "./worker";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const runTipLoop = (deps: TipWorkerDeps, signal: AbortSignal): Promise<void> =>
  new TipWorker(deps).run(signal);

// A MinerSource that counts getStatus calls so we can assert iteration
// cadence without reaching into runTipIteration internals.
function countingClient(counter: { status: number }): MinerSource {
  return {
    getStatus: () => {
      counter.status += 1;
      return Promise.resolve({
        ss58Address: "5GPP",
        accountIdHex: "0x",
        nodeId: "n",
        isMining: true,
        uptimeSeconds: 0,
        chainHeadHash: "0x",
        chainHeadNumber: 0,
        minerRegistered: false,
        minerInfo: null,
        miners: [],
      });
    },
    getStats: () => Promise.reject(new Error("stats not used in loop tests")),
    getMiningAttempts: (n) => Promise.reject(new MiningSubmissionNotFoundError(n)),
  };
}

async function loopDeps(overrides: Partial<TipWorkerDeps> = {}): Promise<TipWorkerDeps> {
  const db = await newInMemoryAdapter();
  const state = new IndexerState(db);
  await state.load();
  return {
    config: makeConfig({ pollIntervalSec: 0.05 }),
    db,
    state,
    clientFactory: () => countingClient({ status: 0 }),
    chainState: new DbChainStateReader(db),
    now: () => Date.parse("2026-05-19T00:00:00Z"),
    ...overrides,
  };
}

describe("TipWorker loop", () => {
  test("runs an iteration immediately on start and repeats on cadence", async () => {
    const counter = { status: 0 };
    const deps = await loopDeps({
      config: makeConfig({ pollIntervalSec: 0.05 }),
      clientFactory: () => countingClient(counter),
    });

    const ac = new AbortController();
    const loop = runTipLoop(deps, ac.signal);
    await wait(170); // ~immediate + at least two 50ms ticks
    ac.abort();
    await loop;

    expect(counter.status).toBeGreaterThanOrEqual(2);
    await deps.db.disconnect();
  });

  test("aborts promptly during the inter-iteration wait (no shutdown hang)", async () => {
    const counter = { status: 0 };
    // Long interval so the loop is parked in the wait after the first run.
    const deps = await loopDeps({
      config: makeConfig({ pollIntervalSec: 60 }),
      clientFactory: () => countingClient(counter),
    });

    const ac = new AbortController();
    const loop = runTipLoop(deps, ac.signal);
    await wait(50); // first iteration done; now parked in the 60s wait
    const abortedAt = Date.now();
    ac.abort();
    await loop;

    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(counter.status).toBe(1);
    await deps.db.disconnect();
  });

  test("once mode runs exactly one iteration and returns without an abort", async () => {
    const counter = { status: 0 };
    const deps = await loopDeps({
      config: makeConfig({ pollIntervalSec: 60, once: true }),
      clientFactory: () => countingClient(counter),
    });

    // No abort — the loop must terminate on its own after a single iteration.
    await runTipLoop(deps, new AbortController().signal);

    expect(counter.status).toBe(1);
    await deps.db.disconnect();
  });

  test("flushes the heartbeat (no client) when no miner-REST URL resolves", async () => {
    let factoryCalls = 0;
    const deps = await loopDeps({
      // Empty validator URLs → resolveSelfMinerRestUrl returns null.
      config: makeConfig({ validatorRpcUrls: [], pollIntervalSec: 60, once: true }),
      clientFactory: () => {
        factoryCalls += 1;
        return countingClient({ status: 0 });
      },
    });

    await runTipLoop(deps, new AbortController().signal);

    expect(factoryCalls).toBe(0);
    const obs = await deps.db.getIndexerObservability();
    expect(obs?.lastStatusFetchAt).toBe("2026-05-19T00:00:00.000Z");
    await deps.db.disconnect();
  });

  test("a throwing iteration is logged and the loop keeps running", async () => {
    let calls = 0;
    const deps = await loopDeps({
      config: makeConfig({ pollIntervalSec: 0.05 }),
      clientFactory: () => {
        calls += 1;
        throw new Error("boom building client");
      },
    });

    const ac = new AbortController();
    const loop = runTipLoop(deps, ac.signal);
    await wait(170);
    ac.abort();
    // The loop must not reject — each throw is swallowed and retried.
    await loop;

    expect(calls).toBeGreaterThanOrEqual(2);
    await deps.db.disconnect();
  });
});
