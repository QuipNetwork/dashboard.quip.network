// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { BlockRecord } from "@quip/shared/telemetry";

import type { MineableTopologyInfo } from "../clients/substrate-client";
import { newInMemoryAdapter } from "../core/test-helpers";
import { backfillTopologyTags, type TopologyBackfillSource } from "./backfill-topology";

const CUR = "0xCUR";
const OLD = "0xOLD";

function block(num: string): BlockRecord {
  return {
    blockHash: `0x${num}`,
    substrateBlockNumber: num,
    substrateBlockHash: `0xsub${num}`,
    substrateParentHash: "0xsub0",
    timestamp: 1_700_000_000,
    minerId: "5GPP",
    energy: -1,
    diversity: 0.1,
    numValidSolutions: 1,
    miningTime: 1,
    reward: "1000",
    qblockId: num,
    nonce: "1",
    numNodes: 1,
    numEdges: 1,
    difficultyEnergy: -1,
    minDiversity: 0,
    minSolutions: 1,
    finalized: true,
    topologyHash: null, // legacy/untagged — the backfill's target
  };
}

// Fake chain: a default topology + historical DefaultTopology by block height.
function source(defaultTopologyByBlock: Record<string, string>): TopologyBackfillSource {
  return {
    getMineableTopologies: async (): Promise<MineableTopologyInfo[]> => [
      {
        topologyHash: CUR,
        isDefault: true,
        difficulty: z(),
        nodeCount: 1,
        edgeCount: 1,
        curveConstant: null,
      },
      {
        topologyHash: OLD,
        isDefault: false,
        difficulty: z(),
        nodeCount: 1,
        edgeCount: 1,
        curveConstant: null,
      },
    ],
    getDefaultTopologyAt: async (n: string): Promise<string | null> =>
      defaultTopologyByBlock[n] ?? null,
  };
}
const z = () => ({ maxEnergyMilli: 0, minDiversityMilli: 0, minSolutions: 0 });

let db: DatabaseAdapter;
beforeEach(async () => {
  db = await newInMemoryAdapter();
});
afterEach(async () => {
  await db.disconnect();
});

describe("backfillTopologyTags", () => {
  it("tags the current-topology run and stops at the last topology change", async () => {
    // Current-topology run 100-102; a prior-topology win at 99 (the boundary).
    for (const n of ["99", "100", "101", "102"]) await db.insertBlock(block(n));
    await db.insertDifficultySnapshot({
      observedAtBlock: "100",
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      observedAt: "2026-01-02T00:00:00.000Z",
      topologyHash: null,
    });
    await db.insertDifficultySnapshot({
      observedAtBlock: "98",
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      topologyHash: null,
    });

    const summary = await backfillTopologyTags({
      source: source({ "99": OLD, "100": CUR, "101": CUR, "102": CUR }),
      store: db,
    });

    expect(summary.tagged).toBe(3);
    expect(summary.reachedBoundary).toBe(true);
    expect(summary.difficultyTagged).toBe(1); // only the row at/after block 100

    // 100-102 in scope; the prior-topology block 99 stays NULL (out of scope).
    const tagged = (await db.getRecentBlocks(10)).reduce<Record<string, string | null>>((m, b) => {
      m[b.substrateBlockNumber] = b.topologyHash;
      return m;
    }, {});
    expect(tagged["102"]).toBe(CUR);
    expect(tagged["100"]).toBe(CUR);
    expect(tagged["99"]).toBe(null);
    expect((await db.getBlocksMissingTopology(10)).map((r) => r.substrateBlockNumber)).toEqual([
      "99",
    ]);
  });

  it("is a no-op when the chain exposes no default topology", async () => {
    await db.insertBlock(block("100"));
    const noDefault: TopologyBackfillSource = {
      getMineableTopologies: async () => [],
      getDefaultTopologyAt: async () => null,
    };
    const summary = await backfillTopologyTags({ source: noDefault, store: db });
    expect(summary.tagged).toBe(0);
    expect(await db.getBlocksMissingTopology(10)).toHaveLength(1); // untouched
  });

  it("stops (without tagging) when historical state is unavailable", async () => {
    await db.insertBlock(block("100"));
    const unreadable: TopologyBackfillSource = {
      getMineableTopologies: async () => [
        {
          topologyHash: CUR,
          isDefault: true,
          difficulty: z(),
          nodeCount: 1,
          edgeCount: 1,
          curveConstant: null,
        },
      ],
      getDefaultTopologyAt: async () => {
        throw new Error("state already discarded");
      },
    };
    const summary = await backfillTopologyTags({ source: unreadable, store: db });
    expect(summary.tagged).toBe(0);
    expect(await db.getBlocksMissingTopology(10)).toHaveLength(1);
  });
});
