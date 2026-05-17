// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  RuntimeVersion,
  TelemetryResponse,
} from "./telemetry";

describe("v5 telemetry types", () => {
  test("BlockRecord carries substrate-side fields incl. substrate_block_number", () => {
    const b: BlockRecord = {
      epoch: "abc",
      blockIndex: 1,
      blockHash: "0x00",
      timestamp: 1,
      previousHash: "0x00",
      minerId: "m",
      minerCategory: "CPU",
      ecdsaPublicKey: "k",
      energy: 0,
      diversity: 0,
      numValidSolutions: 0,
      miningTime: 0,
      nonce: "0",
      numNodes: 0,
      numEdges: 0,
      difficultyEnergy: 0,
      minDiversity: 0,
      minSolutions: 0,
      substrateBlockNumber: null,
      substrateBlockHash: null,
      substrateParentHash: null,
      extrinsicsRoot: null,
      stateRoot: null,
      finalized: false,
      isCanonical: true,
    };
    expect(b.finalized).toBe(false);
    expect(b.isCanonical).toBe(true);
    expect(b.substrateBlockNumber).toBeNull();
  });

  test("RuntimeVersion shape", () => {
    const rv: RuntimeVersion = {
      specName: "quip",
      specVersion: 101,
      transactionVersion: 2,
      implName: "quip",
      lastRuntimeUpgrade: null,
    };
    expect(rv.specVersion).toBe(101);
  });

  test("ChainHead shape", () => {
    const head: ChainHead = {
      bestBlockNumber: "100",
      bestBlockHash: "0xabc",
      finalizedBlockNumber: "98",
      finalizedBlockHash: "0xdef",
      finalityLag: 2,
      runtime: {
        specName: "quip",
        specVersion: 101,
        transactionVersion: 2,
        implName: "quip",
        lastRuntimeUpgrade: null,
      },
      updatedAt: "2026-05-15T00:00:00Z",
    };
    expect(head.finalityLag).toBe(2);
  });

  test("BabeEpochState distinguishes BABE epoch from PoW epoch", () => {
    const e: BabeEpochState = {
      epochIndex: 7,
      currentSlot: "16801",
      epochStartSlot: "16800",
      slotsPerEpoch: 2400,
      currentSlotInEpoch: 1,
      authorityCount: 3,
    };
    expect(e.epochIndex).toBe(7);
    expect(e.slotsPerEpoch).toBe(2400);
  });

  test("BabeAuthorityRecord is thin (no FRAME staking fields)", () => {
    const a: BabeAuthorityRecord = {
      accountId: "5GrwvaEF...",
      displayName: null,
    };
    expect(a.accountId.startsWith("5")).toBe(true);
  });

  test("ChainMinerRecord carries on-chain miner stats", () => {
    const m: ChainMinerRecord = {
      accountId: "5GrwvaEF...",
      deposit: "1000000000000",
      proofsSubmitted: "42",
      proofsWon: "7",
      rewardsEarned: "7000000000000",
      telemetryNodeAddress: null,
    };
    expect(m.proofsWon).toBe("7");
  });

  test("DifficultyRecord snapshot shape", () => {
    const d: DifficultyRecord = {
      observedAtBlock: "100",
      difficultyEnergy: 12.5,
      minDiversity: 0.5,
      minSolutions: 3,
      minQuality: 0.25,
      observedAt: "2026-05-15T00:00:00Z",
    };
    expect(d.difficultyEnergy).toBe(12.5);
    expect(d.minQuality).toBe(0.25);
  });

  test("IndexerObservability carries substrate heartbeat", () => {
    const obs: IndexerObservability = {
      nodeLatestEpoch: "a",
      nodeLatestBlockIndex: 0,
      tipEpoch: null,
      tipBlockIndex: 0,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-05-15T00:00:00Z",
      lastBlockInsertAt: null,
      nodesObservedAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
    };
    expect(obs.chainConnected).toBe(false);
  });

  test("TelemetryResponse carries chain head, BABE epoch, authorities, miners, difficulty", () => {
    const r: TelemetryResponse = {
      blocks: [],
      nodes: { updatedAt: "", nodeCount: 0, activeCount: 0, nodes: {} },
      selfAddress: null,
      indexer: null,
      serverTime: "2026-05-15T00:00:00Z",
      chainHead: null,
      babeEpoch: null,
      babeAuthorities: [],
      chainMiners: [],
      recentDifficulty: [],
    };
    expect(r.chainMiners).toEqual([]);
    expect(r.recentDifficulty).toEqual([]);
  });
});
