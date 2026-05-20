// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import type { MinerStats } from "../src/types/telemetry";

import { AuthError, type NodeStatus, QuipClient } from "./client";
import { IndexerState } from "./state";
import { makeConfig, newInMemoryAdapter } from "./test-helpers";
import { runTipIteration, type TipWorkerDeps } from "./tip-worker";

function fakeClient(opts: {
  status?: Partial<NodeStatus> | "error";
  stats?: Partial<MinerStats> | "error";
}): QuipClient {
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
    totalBlocksAttempted: 23,
    totalBlocksWon: 0,
    winRate: 0,
    totalMiningTime: 0,
    avgMiningTime: 0,
    headsObserved: 23,
    contextsDispatched: 46,
    resultsReceived: 0,
    proofsSubmitted: 0,
    staleDrops: 0,
    submissionErrors: 0,
    ...overrides,
  });
  return {
    getStatus: () =>
      opts.status === "error"
        ? Promise.reject(new Error("[indexer] 502 from /api/v1/status"))
        : Promise.resolve(fullStatus(opts.status)),
    getStats: () =>
      opts.stats === "error"
        ? Promise.reject(new Error("[indexer] 502 from /api/v1/stats"))
        : Promise.resolve(fullStats(opts.stats)),
  } as unknown as QuipClient;
}

async function setupDeps(overrides: Partial<TipWorkerDeps> = {}): Promise<TipWorkerDeps> {
  const db = await newInMemoryAdapter();
  const state = new IndexerState(db);
  await state.load();
  return {
    config: makeConfig(),
    client: fakeClient({}),
    db,
    state,
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

  test("AuthError propagates to caller (fatal)", async () => {
    const client = {
      getStatus: () => Promise.reject(new AuthError("[indexer] 401")),
      getStats: () => Promise.reject(new Error("not reached")),
    } as unknown as QuipClient;
    const deps = await setupDeps({ client });
    await expect(runTipIteration(deps)).rejects.toBeInstanceOf(AuthError);
  });
});
