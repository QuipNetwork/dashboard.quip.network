// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "../api/db/adapter";
import { newInMemoryAdapter } from "../indexer/test-helpers";
import type { BlockRecord, TelemetryResponse } from "@quip/shared/telemetry";
import { createApp } from "./app";

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

let db: DatabaseAdapter;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = await newInMemoryAdapter();
  app = createApp({ db, validatorRpcUrls: ["ws://test-validator:9944"], enableStatic: false });
});

afterEach(async () => {
  await db.disconnect();
});

describe("server app", () => {
  test("GET /api/blocks paginates by limit/offset, newest first", async () => {
    await db.insertBlock(makeBlock({ blockHash: "0xa", substrateBlockNumber: "100" }));
    await db.insertBlock(makeBlock({ blockHash: "0xb", substrateBlockNumber: "101" }));
    await db.insertBlock(makeBlock({ blockHash: "0xc", substrateBlockNumber: "102" }));

    const page1 = await app.fetch(new Request("http://test/api/blocks?limit=2&offset=0"));
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as { blocks: BlockRecord[] };
    expect(body1.blocks.map((b) => b.substrateBlockNumber)).toEqual(["102", "101"]);

    const page2 = await app.fetch(new Request("http://test/api/blocks?limit=2&offset=2"));
    const body2 = (await page2.json()) as { blocks: BlockRecord[] };
    expect(body2.blocks.map((b) => b.substrateBlockNumber)).toEqual(["100"]);
  });

  test("GET /api/blocks clamps a non-positive limit and offset to sane defaults", async () => {
    await db.insertBlock(makeBlock());

    const res = await app.fetch(new Request("http://test/api/blocks?limit=0&offset=-5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: BlockRecord[] };
    expect(body.blocks).toHaveLength(1);
  });

  test("GET /api/telemetry returns the v6 payload shape", async () => {
    await db.insertBlock(makeBlock());

    const res = await app.fetch(new Request("http://test/api/telemetry"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetryResponse;

    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]?.blockHash).toBe("0xpow1");
    expect(body.selfAddress).toBeNull();
    // Indexer observability is null until the indexer writes its first
    // snapshot. The test seed does not invoke the indexer.
    expect(body.indexer).toBeNull();
    expect(typeof body.serverTime).toBe("string");
    expect(body.serverTime).toMatch(/T/); // ISO 8601
    expect(body.chainHead).toBeNull();
    expect(body.babeEpoch).toBeNull();
    expect(body.babeAuthorities).toEqual([]);
    expect(body.chainMiners).toEqual([]);
    expect(body.recentDifficulty).toEqual([]);
    expect(body.validators).toEqual([]);

    // v11 projects `nodes` from `node_descriptors`; null until the
    // descriptor worker observes its first valid `quip-miner identify`
    // registry update. `nodeDescriptors` is the raw per-account record array.
    expect("nodes" in body).toBe(true);
    expect(body.nodes).toBeNull();
    expect("nodeDescriptors" in body).toBe(true);
    expect(body.nodeDescriptors).toEqual([]);
    // The PoW-epoch catalog stayed deleted in v10 — Global Epoch Selector
    // is incompatible with the chain-canonical model.
    expect("epochs" in body).toBe(false);
  });

  test("GET /api/telemetry returns validators joined with the active BABE set", async () => {
    // Seed: two BABE authorities for epoch 7. One has authored 5 heads (3
    // with PoW) recently; the other has authored 1 head, but long enough
    // ago that the online window expires.
    await db.upsertBabeEpoch({
      epochIndex: 7,
      currentSlot: "16801",
      epochStartSlot: "16800",
      slotsPerEpoch: 2400,
      currentSlotInEpoch: 1,
      authorityCount: 3,
    });
    await db.upsertBabeAuthorities(7, [
      { accountId: "5Active", displayName: null },
      { accountId: "5Stale", displayName: null },
      { accountId: "5Idle", displayName: null },
    ]);
    const recentTs = Math.floor(Date.now() / 1000);
    // 1 hour ago: outside the 3-minute online window.
    const oldTs = Math.floor(Date.now() / 1000) - 60 * 60;
    for (let i = 0; i < 5; i++) {
      await db.recordValidatorAuthorship("5Active", String(100 + i), recentTs, i < 3);
    }
    await db.recordValidatorAuthorship("5Stale", "50", oldTs, true);
    // 5Idle never authored.

    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.validators).toHaveLength(3);
    const active = body.validators.find((v) => v.accountId === "5Active");
    const stale = body.validators.find((v) => v.accountId === "5Stale");
    const idle = body.validators.find((v) => v.accountId === "5Idle");
    expect(active?.blocksAuthored).toBe(5);
    expect(active?.blocksAuthoredWithPow).toBe(3);
    expect(active?.online).toBe(true);
    expect(active?.lastAuthoredBlock).toBe("104");
    expect(stale?.blocksAuthored).toBe(1);
    expect(stale?.online).toBe(false);
    expect(idle?.blocksAuthored).toBe(0);
    expect(idle?.lastAuthoredAt).toBeNull();
    expect(idle?.online).toBe(false);
  });

  test("GET /api/telemetry surfaces indexer observability once written", async () => {
    await db.setIndexerObservability({
      chainHeadFromNode: "4939",
      lastStatusFetchAt: "2026-04-22T12:00:00.000Z",
      lastBlockInsertAt: "2026-04-22T11:58:33.000Z",
      lastSubstrateEventAt: "2026-04-22T11:58:30.000Z",
      bestBlockHeight: "4939",
      finalizedBlockHeight: "4937",
      chainConnected: true,
      minerStats: null,
      modes: {},
    });
    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.indexer).not.toBeNull();
    expect(body.indexer?.lastStatusFetchAt).toBe("2026-04-22T12:00:00.000Z");
    expect(body.indexer?.chainHeadFromNode).toBe("4939");
    expect(body.indexer?.chainConnected).toBe(true);
  });

  test("GET /api/telemetry returns chainHead/babeEpoch/chainMiners when populated", async () => {
    await db.upsertChainHead({
      bestBlockNumber: "100",
      bestBlockHash: "0xabc",
      finalizedBlockNumber: "98",
      finalizedBlockHash: "0xdef",
      finalityLag: 2,
      winningSolutionsCount: null,
      runtime: {
        specName: "quip",
        specVersion: 101,
        transactionVersion: 2,
        implName: "quip",
        lastRuntimeUpgrade: null,
      },
      updatedAt: "2026-05-15T00:00:00.000Z",
    });
    await db.upsertBabeEpoch({
      epochIndex: 7,
      currentSlot: "16801",
      epochStartSlot: "16800",
      slotsPerEpoch: 2400,
      currentSlotInEpoch: 1,
      authorityCount: 3,
    });
    await db.upsertBabeAuthorities(7, [
      { accountId: "5GrwvaEF1", displayName: null },
      { accountId: "5GrwvaEF2", displayName: null },
    ]);
    await db.upsertChainMiners([
      {
        accountId: "5GrwvaEF1",
        deposit: "1000",
        proofsSubmitted: "10",
        proofsWon: "3",
        rewardsEarned: "3000",
      },
    ]);
    await db.insertDifficultySnapshot({
      observedAtBlock: "100",
      difficultyEnergy: 12.5,
      minDiversity: 0.5,
      minSolutions: 3,
      observedAt: "2026-05-15T00:00:00.000Z",
    });

    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.chainHead?.bestBlockNumber).toBe("100");
    expect(body.chainHead?.runtime.specVersion).toBe(101);
    expect(body.babeEpoch?.epochIndex).toBe(7);
    expect(body.babeAuthorities.map((a) => a.accountId)).toEqual(["5GrwvaEF1", "5GrwvaEF2"]);
    expect(body.chainMiners).toHaveLength(1);
    expect(body.chainMiners[0]?.proofsWon).toBe("3");
    // No miner_hardware row for this accountId, so the join returns null.
    expect(body.chainMiners[0]?.telemetryNodeAddress).toBeNull();
    expect(body.recentDifficulty).toHaveLength(1);
    expect(body.recentDifficulty[0]?.difficultyEnergy).toBe(12.5);
  });

  test("GET /api/telemetry surfaces the configured self address", async () => {
    await db.setSelfAddress("5GPP");
    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.selfAddress).toBe("5GPP");
  });

  test("chainMiners.telemetryNodeAddress is populated from miner_hardware when a row exists", async () => {
    await db.upsertChainMiners([
      {
        accountId: "5GPP",
        deposit: "1000000000000",
        proofsSubmitted: "5",
        proofsWon: "1",
        rewardsEarned: "1000000000000",
      },
    ]);
    await db.upsertMinerHardware({
      accountId: "5GPP",
      nodeId: "quip-miner-pow",
      miners: [{ id: "quip-miner-pow-CPU-1", type: "CPU" }],
      primaryType: "CPU",
      source: "self",
      observedAt: "2026-05-19T00:00:00.000Z",
    });

    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    const entry = body.chainMiners.find((m) => m.accountId === "5GPP");
    expect(entry?.telemetryNodeAddress).toBe("quip-miner-pow");
  });

  test("chainMiners.telemetryNodeAddress is null when no miner_hardware row exists", async () => {
    await db.upsertChainMiners([
      {
        accountId: "5UNKNOWN",
        deposit: "0",
        proofsSubmitted: "0",
        proofsWon: "0",
        rewardsEarned: "0",
      },
    ]);
    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    const entry = body.chainMiners.find((m) => m.accountId === "5UNKNOWN");
    expect(entry?.telemetryNodeAddress).toBeNull();
  });

  test("GET /api/telemetry/index returns 404 (route removed in v0.3)", async () => {
    const res = await app.fetch(new Request("http://test/api/telemetry/index"));
    expect(res.status).toBe(404);
  });

  test("GET /api/telemetry/epochs/:epoch returns 404 (route removed in v0.3)", async () => {
    const res = await app.fetch(new Request("http://test/api/telemetry/epochs/1700000000"));
    expect(res.status).toBe(404);
  });

  test("GET /api/health returns ok + indexer heartbeat fields", async () => {
    await db.setIndexerObservability({
      chainHeadFromNode: "4939",
      lastStatusFetchAt: "2026-04-22T12:00:00.000Z",
      lastBlockInsertAt: "2026-04-22T11:58:33.000Z",
      lastSubstrateEventAt: "2026-04-22T11:58:30.000Z",
      bestBlockHeight: "4939",
      finalizedBlockHeight: "4937",
      chainConnected: true,
      minerStats: null,
      modes: {},
    });
    const res = await app.fetch(new Request("http://test/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      lastStatusFetchAt: string | null;
      lastSubstrateEventAt: string | null;
      chainConnected: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.lastStatusFetchAt).toBe("2026-04-22T12:00:00.000Z");
    expect(body.lastSubstrateEventAt).toBe("2026-04-22T11:58:30.000Z");
    expect(body.chainConnected).toBe(true);
  });

  test("GET /api/health returns ok=true with null fields before the indexer writes", async () => {
    const res = await app.fetch(new Request("http://test/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      lastStatusFetchAt: string | null;
      chainConnected: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.lastStatusFetchAt).toBeNull();
    expect(body.chainConnected).toBe(false);
  });
});
