// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/miner-wins: all-time per-miner win aggregates from `blocks`, wins
// descending — the single dataset behind every "qblocks won" surface.

import { beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { newInMemoryAdapter } from "@quip/core/test-helpers";
import type { BlockRecord, MinerWinsResponse } from "@quip/shared/telemetry";
import { createApp } from "../app";

let db: DatabaseAdapter;
let app: ReturnType<typeof createApp>;

const block = (overrides: Partial<BlockRecord> & Pick<BlockRecord, "blockHash">): BlockRecord => ({
  substrateBlockNumber: "1",
  substrateBlockHash: "0xsub",
  substrateParentHash: "0xparent",
  timestamp: 1700000000,
  minerId: "5A",
  energy: -1,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 10,
  reward: "1000000000000",
  qblockId: "1",
  nonce: "1",
  numNodes: 2,
  numEdges: 3,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: true,
  topologyHash: null,
  ...overrides,
});

beforeEach(async () => {
  db = await newInMemoryAdapter();
  app = createApp({ db, validatorRpcUrls: [] });
});

async function get(): Promise<Response> {
  return app.fetch(new Request("http://test/api/miner-wins"));
}

describe("GET /api/miner-wins", () => {
  test("returns per-miner aggregates, wins descending", async () => {
    await db.insertBlock(block({ blockHash: "0xa1", substrateBlockNumber: "1", minerId: "5A" }));
    await db.insertBlock(
      block({
        blockHash: "0xa2",
        substrateBlockNumber: "2",
        minerId: "5A",
        timestamp: 1700000100,
      }),
    );
    await db.insertBlock(block({ blockHash: "0xb1", substrateBlockNumber: "3", minerId: "5B" }));

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as MinerWinsResponse;
    expect(body.rows.map((r) => [r.minerId, r.wins])).toEqual([
      ["5A", 2],
      ["5B", 1],
    ]);
    expect(body.rows[0]?.lastWonAt).toBe(1700000100);
  });

  test("returns an empty rows array when no blocks are indexed", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as MinerWinsResponse).rows).toEqual([]);
  });
});
