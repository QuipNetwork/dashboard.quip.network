// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { MiningSubmissionNotFoundError } from "@quip/core/miner-api";
import type {
  MinerStats,
  MiningAttemptsResponse,
  MiningSubmissionRecord,
} from "@quip/shared/telemetry";

import { DbChainStateReader } from "./chain-state";
import { type MinerSource, type NodeStatus } from "./client";
import { IndexerState } from "./state";
import { makeConfig, newInMemoryAdapter } from "./test-helpers";
import { runTipIteration, runTipLoop, type TipIterationDeps, type TipWorkerDeps } from "./tip-worker";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Build a persisted-submission record for a given global solution_number.
// The catch-up loop overwrites minerId + observedAt, so only the shape and
// solutionNumber matter here.
function submissionFor(solutionNumber: number): MiningSubmissionRecord {
  return {
    minerId: "quip-miner-pow-CPU-1",
    solutionNumber,
    minerType: "CPU",
    tsNs: "0",
    energyMilli: -14870000,
    diversityMilli: 375,
    thresholdMilli: -14500000,
    lastProofBlockHash: "0xabc",
    extrinsicHash: null,
    chainBlockHash: null,
    chainBlockNumber: null,
    powSequence: null,
    outcome: "submitted_inblock",
    attemptCount: 2,
    bestEnergyMilli: -14870000,
    numValid: 1,
    qpuAccessTimeUs: 0,
    observedAt: "2026-05-19T00:00:00.000Z",
  };
}

function fakeClient(opts: {
  status?: Partial<NodeStatus> | "error";
  stats?: Partial<MinerStats> | "error";
  // Which global solution_numbers the miner has a directory for. Numbers
  // outside this predicate 404 (a sparse gap from this miner's view).
  // Defaults to "none" so tests that don't exercise catch-up stay inert.
  solutionExists?: (n: number) => boolean;
}): MinerSource {
  const fullStatus = (overrides?: Partial<NodeStatus>): NodeStatus => ({
    ss58Address: "5GPP",
    accountIdHex: "0x",
    nodeId: "quip-miner-pow",
    isMining: true,
    uptimeSeconds: 100,
    chainHeadHash: "0xab",
    chainHeadNumber: 4939,
    minerRegistered: true,
    minerInfo: {
      registeredAt: 4361,
      deposit: "1000000000000",
      proofsSubmitted: "0",
      proofsWon: "0",
      rewardsEarned: "0",
    },
    miners: [{ id: "quip-miner-pow-CPU-1", type: "CPU" }],
    ...overrides,
  });
  const fullStats = (overrides?: Partial<MinerStats>): MinerStats => ({
    headsObserved: 23,
    contextsDispatched: 46,
    resultsReceived: 0,
    proofsSubmitted: 0,
    staleDrops: 0,
    submissionErrors: 0,
    duplicateResultDrops: 0,
    ...overrides,
  });
  const solutionExists = opts.solutionExists ?? (() => false);
  return {
    getStatus: () =>
      opts.status === "error"
        ? Promise.reject(new Error("[indexer] 502 from /api/v1/status"))
        : Promise.resolve(fullStatus(opts.status)),
    getStats: () =>
      opts.stats === "error"
        ? Promise.reject(new Error("[indexer] 502 from /api/v1/stats"))
        : Promise.resolve(fullStats(opts.stats)),
    getMiningAttempts: (n: number): Promise<MiningAttemptsResponse> =>
      solutionExists(n)
        ? Promise.resolve({ submission: submissionFor(n), attempts: [] })
        : Promise.reject(new MiningSubmissionNotFoundError(n)),
  };
}

// Seed chain_head.winning_solutions_count (LatestQBlockId compatibility field) so
// the catch-up loop can derive the global solution_number bound (count + 1).
// This is what the substrate worker writes from chain.
async function seedWinningSolutionsCount(deps: TipIterationDeps, count: number): Promise<void> {
  await deps.db.upsertChainHead({
    bestBlockNumber: "1000",
    bestBlockHash: "0xbest",
    finalizedBlockNumber: "998",
    finalizedBlockHash: "0xfin",
    finalityLag: 2,
    winningSolutionsCount: count,
    runtime: {
      specName: "quip",
      specVersion: 101,
      transactionVersion: 1,
      implName: "quip",
      lastRuntimeUpgrade: null,
    },
    updatedAt: "2026-05-19T00:00:00.000Z",
  });
}

async function setupDeps(overrides: Partial<TipIterationDeps> = {}): Promise<TipIterationDeps> {
  const db = await newInMemoryAdapter();
  const state = new IndexerState(db);
  await state.load();
  return {
    client: fakeClient({}),
    db,
    state,
    chainState: new DbChainStateReader(db),
    now: () => Date.parse("2026-05-19T00:00:00Z"),
    ...overrides,
  };
}

describe("tip-worker v0.3", () => {
  test("writes self miner_hardware and minerStats on happy path", async () => {
    const deps = await setupDeps({ client: fakeClient({}) });
    await runTipIteration(deps);

    expect(await deps.db.getSelfAddress()).toBe("5GPP");
    const hw = await deps.db.getMinerHardware("5GPP");
    expect(hw?.primaryType).toBe("CPU");
    expect(hw?.source).toBe("self");
    expect(hw?.observedAt).toBe("2026-05-19T00:00:00.000Z");
    const obs = await deps.db.getIndexerObservability();
    expect(obs?.minerStats?.headsObserved).toBe(23);
    expect(obs?.chainHeadFromNode).toBe("4939");
  });

  test("derivePrimaryType picks dominant type (multi-miner node)", async () => {
    const deps = await setupDeps({
      client: fakeClient({
        status: {
          miners: [
            { id: "a", type: "CPU" },
            { id: "b", type: "GPU" },
            { id: "c", type: "GPU" },
          ],
        },
      }),
    });
    await runTipIteration(deps);
    expect((await deps.db.getMinerHardware("5GPP"))?.primaryType).toBe("GPU");
  });

  test("502 on /status leaves selfAddress null but heartbeat still advances", async () => {
    const deps = await setupDeps({ client: fakeClient({ status: "error" }) });
    await runTipIteration(deps);
    expect(await deps.db.getSelfAddress()).toBeNull();
    const obs = await deps.db.getIndexerObservability();
    expect(obs?.lastStatusFetchAt).toBe("2026-05-19T00:00:00.000Z");
  });

  test("marks selfIdentified once a live /status probe confirms the ss58", async () => {
    const deps = await setupDeps({ client: fakeClient({}) });
    expect(deps.state.observability.selfIdentified).toBe(false);

    await runTipIteration(deps);

    expect(deps.state.observability.selfIdentified).toBe(true);
    expect((await deps.db.getIndexerObservability())?.selfIdentified).toBe(true);
  });

  test("leaves selfIdentified false when /status is unreachable (configured but not confirmed)", async () => {
    const deps = await setupDeps({ client: fakeClient({ status: "error" }) });

    await runTipIteration(deps);

    expect(deps.state.observability.selfIdentified).toBe(false);
  });

  test("502 on /stats leaves minerStats null but selfAddress lands", async () => {
    const deps = await setupDeps({ client: fakeClient({ stats: "error" }) });
    await runTipIteration(deps);
    expect(await deps.db.getSelfAddress()).toBe("5GPP");
    const obs = await deps.db.getIndexerObservability();
    expect(obs?.minerStats).toBeNull();
  });

  test("setSelfAddress only fires on change (avoids unnecessary writes)", async () => {
    const deps = await setupDeps({ client: fakeClient({}) });
    let setCount = 0;
    const origSet = deps.db.setSelfAddress.bind(deps.db);
    deps.db.setSelfAddress = async (addr: string | null) => {
      setCount++;
      return origSet(addr);
    };
    await runTipIteration(deps);
    expect(setCount).toBe(1);
    await runTipIteration(deps);
    expect(setCount).toBe(1); // unchanged, no re-write
  });

  test("catch-up persists completed solutions bounded by WinningSolutions count", async () => {
    // winning_solutions_count = 5 → current global solution_number = 6, so
    // the stable completed range is 1..5. The miner has a directory for
    // every one (everyone grinds every global solution); all five get
    // persisted and the checkpoint lands on 5. The in-flight one (6) is
    // never persisted.
    const deps = await setupDeps({
      client: fakeClient({ solutionExists: () => true }),
    });
    await seedWinningSolutionsCount(deps, 5);

    await runTipIteration(deps);

    const rows = await deps.db.getRecentMiningSubmissions("5GPP", 50);
    expect(rows.map((r) => r.solutionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(await deps.db.getMiningCheckpoint("5GPP")).toBe(5);
  });

  test("catch-up bound comes from the injected ChainStateReader (no chain_head row)", async () => {
    const deps = await setupDeps({
      client: fakeClient({ solutionExists: () => true }),
      chainState: { currentGlobalSolutionNumber: async () => 4 },
    });

    await runTipIteration(deps);

    const rows = await deps.db.getRecentMiningSubmissions("5GPP", 50);
    expect(rows.map((r) => r.solutionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(await deps.db.getMiningCheckpoint("5GPP")).toBe(3);
  });

  test("404 gaps are skipped, not stopped — the checkpoint still advances", async () => {
    // Solution 3 has no directory for this miner (it came online late, or
    // that win was another miner's). The walk must skip it and keep going,
    // not halt at the gap.
    const deps = await setupDeps({
      client: fakeClient({ solutionExists: (n) => n !== 3 }),
    });
    await seedWinningSolutionsCount(deps, 5);

    await runTipIteration(deps);

    const rows = await deps.db.getRecentMiningSubmissions("5GPP", 50);
    expect(rows.map((r) => r.solutionNumber).sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
    expect(await deps.db.getMiningCheckpoint("5GPP")).toBe(5);
  });

  test("first contact seeds the checkpoint near the head (no ancient grind)", async () => {
    // winning_solutions_count = 1000 → completed range 1..1000, but a fresh
    // checkpoint must not fetch all 1000. It seeds to 1000 - BACKFILL_WINDOW
    // (800) and fetches one capped page (801..825), leaving the rest for
    // later ticks.
    const deps = await setupDeps({
      client: fakeClient({ solutionExists: () => true }),
    });
    await seedWinningSolutionsCount(deps, 1000);

    await runTipIteration(deps);

    const rows = await deps.db.getRecentMiningSubmissions("5GPP", 5000);
    const nums = rows.map((r) => r.solutionNumber).sort((a, b) => a - b);
    expect(nums[0]).toBe(801);
    expect(nums.at(-1)).toBe(825);
    expect(nums.length).toBe(25);
    expect(await deps.db.getMiningCheckpoint("5GPP")).toBe(825);
  });

  test("no chain_head yet → catch-up is skipped (bound is unknown)", async () => {
    // The substrate worker hasn't written chain_head.winning_solutions_count,
    // so the global solution_number can't be derived. Catch-up must no-op
    // rather than bound the walk on a bogus 0.
    const deps = await setupDeps({
      client: fakeClient({ solutionExists: () => true }),
    });

    await runTipIteration(deps);

    expect((await deps.db.getRecentMiningSubmissions("5GPP", 50)).length).toBe(0);
    expect(await deps.db.getMiningCheckpoint("5GPP")).toBeNull();
  });

  test("a restart does not wipe persisted history (solution_number only advances)", async () => {
    // The old reset-on-counter-regression wipe is gone: with a durable,
    // chain-derived solution_number there's no rewind to detect, so a
    // restart (controller counters back to 0) must leave history intact.
    const deps = await setupDeps({
      client: fakeClient({ stats: { resultsReceived: 0 }, solutionExists: () => true }),
    });
    await seedWinningSolutionsCount(deps, 5);
    await deps.db.insertMiningSubmission({ ...submissionFor(5), minerId: "5GPP" });
    await deps.db.setMiningCheckpoint("5GPP", 5);

    await runTipIteration(deps);

    // Checkpoint already at the head (5) → nothing new fetched, nothing wiped.
    expect(await deps.db.getMiningCheckpoint("5GPP")).toBe(5);
    const rows = await deps.db.getRecentMiningSubmissions("5GPP", 50);
    expect(rows.map((r) => r.solutionNumber)).toEqual([5]);
  });
});

// --- Loop-cadence invariants (rxjs-migration safety net) ---
// The loop wraps runTipIteration in a fixed cadence with prompt-abort, a
// run-once-and-return mode, and a heartbeat-only fallback when no miner-REST
// URL resolves. These must hold identically after the loop is reshaped into
// an rxjs timer→exhaustMap→takeUntil pipeline.

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

describe("runTipLoop", () => {
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
