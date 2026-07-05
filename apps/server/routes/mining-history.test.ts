// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/mining-history?since=<iso>: slim winner-block rows at/after the cutoff,
// ascending by block number — the range-windowed dataset behind the
// "Mining Time per QBlock" chart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { newInMemoryAdapter } from "@quip/core/test-helpers";
import type { BlockRecord, MiningHistoryResponse } from "@quip/shared/telemetry";
import { createApp } from "../app";

let db: DatabaseAdapter;
let app: ReturnType<typeof createApp>;

const block = (n: number, minerId: string, timestamp: number, miningTime: number): BlockRecord => ({
  blockHash: `0xpow${n}`,
  substrateBlockNumber: String(n),
  substrateBlockHash: `0xsub${n}`,
  substrateParentHash: `0xsub${n - 1}`,
  timestamp,
  minerId,
  energy: -1.5,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime,
  reward: "1000000000000",
  qblockId: String(n),
  nonce: "1",
  numNodes: 2,
  numEdges: 3,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: true,
  topologyHash: null,
  deviceAccessTimeUs: null,
});

beforeEach(async () => {
  db = await newInMemoryAdapter();
  app = createApp({ db, validatorRpcUrls: ["ws://test:9944"], enableStatic: false });
  await db.insertBlock(block(1, "5A", Date.parse("2026-06-01T00:00:00Z") / 1000, 10));
  await db.insertBlock(block(2, "5B", Date.parse("2026-06-15T00:00:00Z") / 1000, 7));
  await db.insertBlock(block(3, "5A", Date.parse("2026-07-01T00:00:00Z") / 1000, 20));
});

afterEach(async () => {
  await db.disconnect();
});

async function get(query: string): Promise<Response> {
  return app.fetch(new Request(`http://test/api/mining-history${query}`));
}

describe("GET /api/mining-history", () => {
  test("returns slim in-window rows ascending by block number", async () => {
    const res = await get("?since=2026-06-10T00:00:00.000Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MiningHistoryResponse;
    expect(body.since).toBe("2026-06-10T00:00:00.000Z");
    expect(body.rows).toEqual([
      {
        qblockId: "2",
        substrateBlockNumber: "2",
        timestamp: Date.parse("2026-06-15T00:00:00Z") / 1000,
        minerId: "5B",
        miningTime: 7,
      },
      {
        qblockId: "3",
        substrateBlockNumber: "3",
        timestamp: Date.parse("2026-07-01T00:00:00Z") / 1000,
        minerId: "5A",
        miningTime: 20,
      },
    ]);
  });

  test("returns [] when nothing is in-window", async () => {
    const res = await get("?since=2026-07-02T00:00:00.000Z");
    const body = (await res.json()) as MiningHistoryResponse;
    expect(body.rows).toEqual([]);
  });

  test("rejects a missing or malformed since", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?since=yesterday")).status).toBe(400);
  });
});
