// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Step-4 gate (spec §15.4): plugin rows must be byte-identical to what the
// old paths (`blocks.ts` / `polls.ts` / `descriptor/iteration.ts`) write for
// the same post-v0.2 inputs; pre-v0.2 winner inputs assert the decided
// values instead (ZERO_DIFFICULTY blocks-row triple, no difficulty_history
// row — spec §10.2).

import { beforeEach, describe, expect, it, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { BlockEvents, QBlockInfo, TopologyInfo } from "../../clients/substrate-client";
import { IndexerState } from "../../core/state";
import { newInMemoryAdapter } from "../../core/test-helpers";
import type { ChainClient } from "../../substrate/ports";
import type { BlockContext } from "../plugin";
import { authorshipPlugin } from "./authorship";
import { babeEpochPlugin } from "./babe-epoch";
import { chainStatePlugin } from "./chain-state";
import { difficultyPlugin } from "./difficulty";
import { difficultyCurrentPlugin } from "./difficulty-current";
import { nodeDescriptorsPlugin } from "./node-descriptors";
import { winnersPlugin } from "./winners";

const NOW_MS = 1_750_000_000_000;

function makeEvents(overrides: Partial<BlockEvents> = {}): BlockEvents {
  return {
    blockNumber: 500_000,
    blockHash: "0xblock",
    parentHash: "0xparent",
    author: "5GAuthor",
    timestamp: 1_700_000_000,
    winner: {
      miner: "5GWinner",
      energyMilli: -14_500_123,
      reward: "1000000000000",
      qblockId: "3900",
      blockNumber: "500000",
    },
    proofs: [
      {
        miner: "5GWinner",
        energyMilli: -14_500_123,
        diversityMilli: 512,
        validSolutionCount: 3,
      },
    ],
    nonce: "123456789",
    ...overrides,
  } as BlockEvents;
}

function makeQBlock(overrides: Partial<QBlockInfo> = {}): QBlockInfo {
  return {
    miner: "5GWinner",
    energyMilli: -14_500_123,
    reward: "1000000000000",
    submittedAt: "500000",
    nonce: "123456789",
    difficulty: { maxEnergyMilli: -14_400_000, minDiversityMilli: 100, minSolutions: 2 },
    deviceAccessTimeUs: null,
    topologyHash: null,
    ...overrides,
  };
}

const TOPOLOGY: TopologyInfo = { nodeCount: 64, edgeCount: 128 };

function makeCtx(
  overrides: Partial<{
    events: BlockEvents;
    qblock: QBlockInfo | null;
    lastProof: number;
    topologyHash: string | null;
    source: "tip" | "backfill";
  }> = {},
): BlockContext {
  const events = overrides.events ?? makeEvents();
  return {
    number: events.blockNumber,
    source: overrides.source ?? "backfill",
    events,
    qblock: async () => (overrides.qblock === undefined ? makeQBlock() : overrides.qblock),
    lastProofBlockAtParent: async () => overrides.lastProof ?? 499_990,
    defaultTopologyAt: async () =>
      overrides.topologyHash === undefined ? "0xTOPO" : overrides.topologyHash,
    topology: async () => TOPOLOGY,
  };
}

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await newInMemoryAdapter();
});

describe("winners plugin", () => {
  it("writes the exact BlockRecord the old enrich path wrote (post-v0.2)", async () => {
    await winnersPlugin().onBlock(makeCtx(), db);
    const [b] = await db.getRecentBlocks(10);
    expect(b).toEqual({
      blockHash: "0xblock",
      substrateBlockNumber: "500000",
      substrateBlockHash: "0xblock",
      substrateParentHash: "0xparent",
      timestamp: 1_700_000_000,
      minerId: "5GWinner",
      energy: -14_500.123,
      diversity: 0.512,
      numValidSolutions: 3,
      miningTime: 60, // (500000 - 499990) blocks × 6s BABE slots
      reward: "1000000000000",
      qblockId: "3900",
      nonce: "123456789",
      numNodes: 64,
      numEdges: 128,
      difficultyEnergy: -14_400,
      minDiversity: 0.1,
      minSolutions: 2,
      finalized: true,
      topologyHash: "0xTOPO",
    });
  });

  it("running twice leaves one row (idempotent)", async () => {
    const plugin = winnersPlugin();
    await plugin.onBlock(makeCtx(), db);
    await plugin.onBlock(makeCtx(), db);
    expect(await db.getRecentBlocks(10)).toHaveLength(1);
  });

  it("pre-v0.2 winner (no qblock) writes the decided ZERO_DIFFICULTY triple", async () => {
    await winnersPlugin().onBlock(makeCtx({ qblock: null }), db);
    const [b] = await db.getRecentBlocks(10);
    expect(b?.difficultyEnergy).toBe(0);
    expect(b?.minDiversity).toBe(0);
    expect(b?.minSolutions).toBe(0);
  });

  it("lastProofBlock ≤ 0 → miningTime 0 (mirrors blocks.ts:91-92)", async () => {
    await winnersPlugin().onBlock(makeCtx({ lastProof: 0 }), db);
    const [b] = await db.getRecentBlocks(10);
    expect(b?.miningTime).toBe(0);
  });

  it("skips winnerless blocks and unmatchable winners without throwing", async () => {
    const plugin = winnersPlugin();
    await plugin.onBlock(makeCtx({ events: makeEvents({ winner: null }) }), db);
    await plugin.onBlock(makeCtx({ events: makeEvents({ proofs: [] }) }), db);
    await plugin.onBlock(makeCtx({ events: makeEvents({ nonce: null }) }), db);
    expect(await db.getRecentBlocks(10)).toHaveLength(0);
  });

  test("spec-111 reported compute time replaces the derived wall clock", async () => {
    await winnersPlugin().onBlock(
      makeCtx({ qblock: makeQBlock({ deviceAccessTimeUs: 45_500_000 }) }),
      db,
    );
    const [b] = await db.getRecentBlocks(10);
    expect(b?.miningTime).toBe(45.5); // µs → float seconds, not floored
  });

  test("deviceAccessTimeUs 0 (present but unreported) keeps the derived value", async () => {
    await winnersPlugin().onBlock(makeCtx({ qblock: makeQBlock({ deviceAccessTimeUs: 0 }) }), db);
    const [b] = await db.getRecentBlocks(10);
    expect(b?.miningTime).toBe(60); // (500000 - 499990) blocks × 6s
  });

  it("dropState deletes blocks rows", async () => {
    await winnersPlugin().onBlock(makeCtx(), db);
    await winnersPlugin().dropState(db);
    expect(await db.getRecentBlocks(10)).toHaveLength(0);
  });
});

describe("difficulty plugin", () => {
  it("writes the mined-against difficulty at the win block, source='block'", async () => {
    await difficultyPlugin().onBlock(makeCtx(), db);
    const rows = await db.getRecentDifficulty(10);
    expect(rows).toEqual([
      {
        observedAtBlock: "500000",
        difficultyEnergy: -14_400,
        minDiversity: 0.1,
        minSolutions: 2,
        observedAt: new Date(1_700_000_000 * 1000).toISOString(),
        topologyHash: "0xTOPO",
        source: "block",
      },
    ]);
  });

  it("pre-v0.2 winner (no qblock) writes no row — the decided skip", async () => {
    await difficultyPlugin().onBlock(makeCtx({ qblock: null }), db);
    expect(await db.getRecentDifficulty(10)).toHaveLength(0);
  });

  it("is idempotent and converts an occupying poll row", async () => {
    await db.insertDifficultySnapshot({
      observedAtBlock: "500000",
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      topologyHash: null,
      source: "poll",
    });
    const plugin = difficultyPlugin();
    await plugin.onBlock(makeCtx(), db);
    await plugin.onBlock(makeCtx(), db);
    const rows = await db.getRecentDifficulty(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("block");
    expect(rows[0]?.difficultyEnergy).toBe(-14_400);
  });

  it("dropState deletes only source='block' rows", async () => {
    await db.insertDifficultySnapshot({
      observedAtBlock: "1",
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      topologyHash: null,
      source: "poll",
    });
    await difficultyPlugin().onBlock(makeCtx(), db);
    await difficultyPlugin().dropState(db);
    const rows = await db.getRecentDifficulty(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("poll");
  });
});

describe("authorship plugin", () => {
  it("records one row per (validator, block); replay never double-counts", async () => {
    const plugin = authorshipPlugin();
    await plugin.onBlock(makeCtx(), db);
    await plugin.onBlock(makeCtx(), db); // replay
    const [a] = await db.getValidatorAuthorship();
    expect(a?.accountId).toBe("5GAuthor");
    expect(a?.blocksAuthored).toBe(1);
    expect(a?.blocksAuthoredWithPow).toBe(1); // winner present on the fixture
  });

  it("authorless blocks record nothing", async () => {
    await authorshipPlugin().onBlock(makeCtx({ events: makeEvents({ author: null }) }), db);
    expect(await db.getValidatorAuthorship()).toHaveLength(0);
  });

  it("dropState clears rows and the cutover flag (reads fall back to the union)", async () => {
    const plugin = authorshipPlugin();
    await plugin.onBlock(makeCtx(), db);
    expect(await db.tryAuthorshipCutover()).toBe(true); // summary now holds 1 row
    await plugin.dropState(db);
    // new table empty + cutover cleared → union serves the frozen summary
    const [a] = await db.getValidatorAuthorship();
    expect(a?.accountId).toBe("5GAuthor");
    expect(a?.blocksAuthored).toBe(1);
  });

  it("startBlock seeds at the current chain head, not genesis (no whole-chain walk)", async () => {
    // No on-chain authored-block counter exists, so lifetime counts would
    // require a [0, head] dense walk. We deliberately floor at the head and
    // accumulate from tip-following instead, so a fresh index never pays that.
    const client = { getFinalizedHead: async () => "568089" } as unknown as ChainClient;
    expect(await authorshipPlugin().startBlock(client)).toBe(568_089);
  });
});

describe("snapshot plugins", () => {
  function makeState(finalized: string | null): IndexerState {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = finalized;
    return state;
  }

  const fakeClient = (overrides: Record<string, unknown>): ChainClient =>
    overrides as unknown as ChainClient;

  it("difficulty-current stamps the finalized head with source='poll'", async () => {
    const plugin = difficultyCurrentPlugin(() => NOW_MS);
    const client = fakeClient({
      getDifficulty: async () => ({
        maxEnergyMilli: -14_530_000,
        minDiversityMilli: 100,
        minSolutions: 2,
      }),
    });
    const state = makeState("500123");
    state.defaultTopologyHash = "0xTOPO";
    await plugin.poll(client, db, state);
    const rows = await db.getRecentDifficulty(10);
    expect(rows).toEqual([
      {
        observedAtBlock: "500123",
        difficultyEnergy: -14_530,
        minDiversity: 0.1,
        minSolutions: 2,
        observedAt: new Date(NOW_MS).toISOString(),
        topologyHash: "0xTOPO",
        source: "poll",
      },
    ]);
    // dedup: unchanged value on the next tick writes nothing new
    state.observability.finalizedBlockHeight = "500124";
    await plugin.poll(client, db, state);
    expect(await db.getRecentDifficulty(10)).toHaveLength(1);
  });

  it("difficulty-current skips before the first finalized head", async () => {
    const plugin = difficultyCurrentPlugin(() => NOW_MS);
    const client = fakeClient({
      getDifficulty: async () => ({ maxEnergyMilli: -1, minDiversityMilli: 0, minSolutions: 1 }),
    });
    await plugin.poll(client, db, makeState(null));
    expect(await db.getRecentDifficulty(10)).toHaveLength(0);
  });

  it("chain-state publishes the default topology hash and writes miners", async () => {
    const plugin = chainStatePlugin();
    const client = fakeClient({
      getChainMiners: async () => [
        {
          accountId: "5GM",
          deposit: "1",
          proofsSubmitted: "2",
          proofsWon: "1",
          rewardsEarned: "10",
        },
      ],
      getBabeAuthorities: async () => [],
      getBabeEpoch: async () => null,
      getMineableTopologies: async () => [
        {
          topologyHash: "0xDEF",
          isDefault: true,
          difficulty: { maxEnergyMilli: -1000, minDiversityMilli: 100, minSolutions: 1 },
          nodeCount: 8,
          edgeCount: 16,
          curveConstant: null,
        },
      ],
    });
    const state = makeState("100");
    await plugin.poll(client, db, state);
    expect(state.defaultTopologyHash).toBe("0xDEF");
    expect((await db.getChainMiners()).map((m) => m.accountId)).toEqual(["5GM"]);
  });

  it("babe-epoch writes the epoch with the modulo slot offset", async () => {
    const plugin = babeEpochPlugin();
    const client = fakeClient({
      getBabeEpoch: async () => ({
        epochIndex: 7,
        currentSlot: "2405",
        epochStartSlot: "0",
        slotsPerEpoch: 2400,
        authorityCount: 3,
      }),
    });
    await plugin.poll(client, db, makeState("100"));
    const epoch = await db.getCurrentBabeEpoch();
    expect(epoch?.epochIndex).toBe(7);
    expect(epoch?.currentSlotInEpoch).toBe(5);
  });

  it("node-descriptors snapshots the finalized head and advances the checkpoint", async () => {
    const plugin = nodeDescriptorsPlugin(() => NOW_MS);
    const client = fakeClient({
      getMinerRegistryDescriptorsAt: async (blockNumber: string) => [
        {
          accountId: "5GN",
          blockNumber,
          blockHash: "0xdesc",
          blockTimestamp: 1_700_000_000,
          updatedAt: "4500",
          descriptor: {
            schema: "quip.node_descriptor.v1",
            descriptorVersion: 1,
            nodeName: "rig",
          },
        },
      ],
    });
    await plugin.poll(client, db, makeState("321"));
    const rows = await db.getAllNodeDescriptors();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe("5GN");
    expect(await db.getDescriptorCheckpoint()).toBe("321");
  });

  it("node-descriptors idles before the first finalized head", async () => {
    const plugin = nodeDescriptorsPlugin(() => NOW_MS);
    const client = fakeClient({
      getMinerRegistryDescriptorsAt: async () => {
        throw new Error("must not be called");
      },
    });
    await plugin.poll(client, db, makeState(null));
    expect(await db.getAllNodeDescriptors()).toHaveLength(0);
  });
});
