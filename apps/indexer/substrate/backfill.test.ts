// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lastValueFrom, toArray } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { BlockRecord } from "@quip/shared/telemetry";

import type { BlockEvents } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";
import type { WorkerContext } from "../core/worker";
import { Backfill } from "./backfill";
import type { BackfillSource } from "./ports";

const block = (n: string): BlockRecord => ({
  blockHash: `0x${n}`,
  substrateBlockNumber: n,
  substrateBlockHash: `0xsub${n}`,
  substrateParentHash: "0xsub0",
  timestamp: 1_700_000_000,
  minerId: "5GPP",
  energy: -1,
  diversity: 0.1,
  numValidSolutions: 1,
  miningTime: 1,
  reward: "1000",
  qblockId: "1",
  nonce: "1",
  numNodes: 1,
  numEdges: 1,
  difficultyEnergy: -1,
  minDiversity: 0,
  minSolutions: 1,
  finalized: true,
  topologyHash: null,
});

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await newInMemoryAdapter();
});
afterEach(async () => {
  await db.disconnect();
});

describe("Backfill", () => {
  it("only fetches winners absent from the local store, regardless of recency", async () => {
    // Block 20 is already stored; 10 and 30 are not.
    await db.insertBlock(block("20"));

    const processed: string[] = [];
    const client: BackfillSource = {
      async getWinningBlockNumbers() {
        return ["30", "10", "20"];
      },
      async processFinalizedBlock(n) {
        processed.push(n);
        return null;
      },
    };
    const ctx: WorkerContext = {
      config: makeConfig(),
      db,
      state: new IndexerState(db),
      now: () => 0,
    };

    await lastValueFrom(new Backfill(ctx, client).stream().pipe(toArray()), { defaultValue: [] });

    // The present winner (20) is skipped; the absent ones are fetched ascending.
    expect(processed).toEqual(["10", "30"]);
  });

  it("no-ops when the chain reports no winners", async () => {
    let processedCalls = 0;
    const client: BackfillSource = {
      async getWinningBlockNumbers() {
        return [];
      },
      async processFinalizedBlock(): Promise<BlockEvents | null> {
        processedCalls += 1;
        return null;
      },
    };
    const ctx: WorkerContext = {
      config: makeConfig(),
      db,
      state: new IndexerState(db),
      now: () => 0,
    };

    await lastValueFrom(new Backfill(ctx, client).stream().pipe(toArray()), { defaultValue: [] });
    expect(processedCalls).toBe(0);
  });
});
