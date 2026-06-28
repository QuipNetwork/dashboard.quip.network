// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import type {
  BlockRecord,
  ChainMinerRecord,
  IndexerObservability,
  MinerHardwareRecord,
  MinerStats,
  TelemetryResponse,
} from "./telemetry";

describe("v6 telemetry types", () => {
  test("BlockRecord drops epoch concept; substrate fields are non-null", () => {
    const b: BlockRecord = {
      blockHash: "0xpow",
      substrateBlockNumber: "4500",
      substrateBlockHash: "0xsub",
      substrateParentHash: "0xpar",
      timestamp: 1700000000,
      minerId: "5GPP…cF64",
      energy: -2510,
      diversity: 0.42,
      numValidSolutions: 5,
      miningTime: 12,
      reward: "1000000000000",
      qblockId: "7",
      nonce: "42",
      numNodes: 100,
      numEdges: 200,
      difficultyEnergy: -2500,
      minDiversity: 0.2,
      minSolutions: 5,
      finalized: false,
    };
    expect(b.substrateBlockNumber).toBe("4500");
    // @ts-expect-error - epoch is gone from v0.3
    b.epoch;
    // @ts-expect-error - blockIndex is gone from v0.3
    b.blockIndex;
    // @ts-expect-error - minerCategory now lives on MinerHardwareRecord
    b.minerCategory;
    // @ts-expect-error - ecdsaPublicKey is gone from v0.3
    b.ecdsaPublicKey;
    // @ts-expect-error - isCanonical is gone (no more stale forks)
    b.isCanonical;

    // String-encoded fields must reject numeric values.
    const _r: BlockRecord = {
      ...b,
      // @ts-expect-error - reward is u128 as string
      reward: 1000,
    };
    const _n: BlockRecord = {
      ...b,
      // @ts-expect-error - nonce is u64 as string
      nonce: 42,
    };
    expect(_r.blockHash).toBe(b.blockHash);
    expect(_n.blockHash).toBe(b.blockHash);
  });

  test("MinerHardwareRecord carries source enum for forward-compat", () => {
    const m: MinerHardwareRecord = {
      accountId: "5GPP…cF64",
      nodeId: "quip-miner-pow",
      miners: [{ id: "quip-miner-pow-CPU-1", type: "CPU" }],
      primaryType: "CPU",
      source: "self",
      observedAt: "2026-05-19T00:00:00Z",
    };
    expect(m.source).toBe("self");
  });

  test("MinerStats mirrors /api/v1/stats payload", () => {
    const s: MinerStats = {
      headsObserved: 23,
      contextsDispatched: 46,
      resultsReceived: 0,
      proofsSubmitted: 0,
      staleDrops: 0,
      submissionErrors: 0,
      duplicateResultDrops: 0,
    };
    expect(s.headsObserved).toBe(23);
  });

  test("IndexerObservability drops epoch cursors; carries minerStats", () => {
    const obs: IndexerObservability = {
      chainHeadFromNode: "4939",
      lastStatusFetchAt: "2026-05-19T00:00:00Z",
      lastBlockInsertAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
      minerStats: null,
      modes: {},
    };
    expect(obs.minerStats).toBeNull();
    // @ts-expect-error - epoch fields gone
    obs.nodeLatestEpoch;
    // @ts-expect-error - backfill cursor gone
    obs.backfillEpoch;
    // @ts-expect-error - nodes-related gone
    obs.nodesObservedAt;
  });

  test("TelemetryResponse carries nodes (projected from descriptors) + nodeDescriptors", () => {
    const r: TelemetryResponse = {
      blocks: [],
      selfAddress: null,
      indexer: null,
      serverTime: "2026-05-19T00:00:00Z",
      chainHead: null,
      babeEpoch: null,
      babeAuthorities: [],
      chainMiners: [],
      recentDifficulty: [],
      mineableTopologies: [],
      validators: [],
      nodes: null,
      nodeDescriptors: [],
      recentMiningSubmissions: [],
      selfProblemsAttempted: 0,
      currentDispatch: null,
    };
    // `nodes` is nullable until the descriptor worker observes its first
    // valid `quip-miner identify` extrinsic. `nodeDescriptors` is the raw
    // per-account record array — empty when nothing has been observed.
    expect(r.nodes).toBeNull();
    expect(r.nodeDescriptors).toEqual([]);
  });

  test("ChainMinerRecord.telemetryNodeAddress now joined from miner_hardware", () => {
    const m: ChainMinerRecord = {
      accountId: "5GPP…cF64",
      deposit: "1000000000000",
      proofsSubmitted: "5",
      proofsWon: "1",
      rewardsEarned: "1000000000000",
      telemetryNodeAddress: "quip-miner-pow",
      hardware: null,
    };
    expect(m.telemetryNodeAddress).toBe("quip-miner-pow");
  });
});
