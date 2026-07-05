// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { MiningSubmissionNotFoundError } from "@quip/core/miner-api";
import type {
  MinerStats,
  MiningAttemptsResponse,
  MiningSubmissionRecord,
} from "@quip/shared/telemetry";

import { DbChainStateReader } from "../core/chain-state";
import { type MinerSource, type NodeStatus } from "../clients/miner-client";
import { IndexerState } from "../core/state";
import { newInMemoryAdapter } from "../core/test-helpers";
import { runTipIteration, type TipIterationDeps } from "./iteration";

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
    qblockCount: count,
    currentQBlockId: String(count + 1),
    currentQBlockParticipants: null,
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

  test("derivePrimaryType prefers GPU capability even when CPU workers outnumber it", async () => {
    // Real case: an Apple-silicon rig runs 6 CPU workers + 1 GPU/MPS miner.
    // By raw process count CPU wins 6-to-1, but the node is a GPU node — the
    // CPU workers are incidental filler. Classification is capability-priority
    // (GPU > QPU > CPU > OTHER), not most-frequent.
    const deps = await setupDeps({
      client: fakeClient({
        status: {
          miners: [
            { id: "quip-miner-CPU-1", type: "CPU" },
            { id: "quip-miner-CPU-2", type: "CPU" },
            { id: "quip-miner-CPU-3", type: "CPU" },
            { id: "quip-miner-CPU-4", type: "CPU" },
            { id: "quip-miner-CPU-5", type: "CPU" },
            { id: "quip-miner-CPU-6", type: "CPU" },
            { id: "quip-miner-GPU-MPS", type: "GPU" },
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
