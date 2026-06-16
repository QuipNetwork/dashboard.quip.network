// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { TelemetryClient } from "@/services/telemetry-client";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  MiningAttemptsResponse,
  TelemetryResponse,
  ValidatorAuthorshipRecord,
} from "@quip/shared/telemetry";
import {
  createTelemetryStore,
  selectServerNowMs,
  selectTipBlock,
  type TelemetryState,
} from "./telemetry-store";

// ---- Fixtures ----------------------------------------------------------

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GPP",
    energy: -100,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    reward: "1000000000000",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    finalized: false,
    ...overrides,
  };
}

const MOCK_CHAIN_HEAD: ChainHead = {
  bestBlockNumber: "100",
  bestBlockHash: "0xbest",
  finalizedBlockNumber: "97",
  finalizedBlockHash: "0xfin",
  finalityLag: 3,
  winningSolutionsCount: 99,
  runtime: {
    specName: "quip",
    specVersion: 101,
    transactionVersion: 1,
    implName: "quip-node",
    lastRuntimeUpgrade: null,
  },
  updatedAt: "2026-05-19T12:00:00Z",
};

const MOCK_BABE_EPOCH: BabeEpochState = {
  epochIndex: 42,
  currentSlot: "100500",
  epochStartSlot: "100000",
  slotsPerEpoch: 2400,
  currentSlotInEpoch: 500,
  authorityCount: 4,
};

const MOCK_BABE_AUTHORITY: BabeAuthorityRecord = {
  accountId: "5GAuth",
  displayName: null,
};

const MOCK_CHAIN_MINER: ChainMinerRecord = {
  accountId: "5GPP",
  deposit: "1000",
  proofsSubmitted: "10",
  proofsWon: "3",
  rewardsEarned: "300",
  telemetryNodeAddress: null,
  hardware: null,
};

const MOCK_DIFFICULTY: DifficultyRecord = {
  observedAtBlock: "100",
  difficultyEnergy: -110,
  minDiversity: 0.1,
  minSolutions: 1,
  observedAt: "2026-05-19T12:00:00Z",
};

const MOCK_VALIDATOR: ValidatorAuthorshipRecord = {
  accountId: "5GAuth",
  blocksAuthored: 12,
  blocksAuthoredWithPow: 4,
  lastAuthoredBlock: "100",
  lastAuthoredAt: "2026-05-19T12:00:00Z",
  online: true,
};

const MOCK_INDEXER: IndexerObservability = {
  chainHeadFromNode: "100",
  lastStatusFetchAt: "2026-05-19T12:00:00Z",
  lastBlockInsertAt: "2026-05-19T11:59:00Z",
  lastSubstrateEventAt: "2026-05-19T12:00:00Z",
  bestBlockHeight: "100",
  finalizedBlockHeight: "97",
  chainConnected: true,
  minerStats: null,
  modes: {},
};

function makeResponse(overrides: Partial<TelemetryResponse> = {}): TelemetryResponse {
  return {
    blocks: [makeBlock()],
    selfAddress: "5GPP",
    indexer: MOCK_INDEXER,
    serverTime: "2026-05-19T12:00:00Z",
    chainHead: MOCK_CHAIN_HEAD,
    babeEpoch: MOCK_BABE_EPOCH,
    babeAuthorities: [MOCK_BABE_AUTHORITY],
    chainMiners: [MOCK_CHAIN_MINER],
    recentDifficulty: [MOCK_DIFFICULTY],
    validators: [MOCK_VALIDATOR],
    nodes: null,
    nodeDescriptors: [],
    recentMiningSubmissions: [],
    selfProblemsAttempted: 0,
    currentDispatch: null,
    ...overrides,
  };
}

function makeState(blocks: BlockRecord[], overrides: Partial<TelemetryState> = {}): TelemetryState {
  return {
    blocks,
    selfAddress: null,
    indexer: null,
    serverTime: null,
    chainHead: null,
    babeEpoch: null,
    babeAuthorities: [],
    chainMiners: [],
    recentDifficulty: [],
    validators: [],
    nodes: null,
    nodeDescriptors: [],
    recentMiningSubmissions: [],
    selfProblemsAttempted: 0,
    currentDispatch: null,
    loading: false,
    error: null,
    fetchTelemetry: async () => {},
    ...overrides,
  };
}

// ---- fake client injection ---------------------------------------------

interface FakeClient extends TelemetryClient {
  calls: number;
}

function clientReturning(response: TelemetryResponse): FakeClient {
  const client: FakeClient = {
    calls: 0,
    fetchTelemetry: async () => {
      client.calls += 1;
      return response;
    },
    fetchMiningAttempts: async (): Promise<MiningAttemptsResponse> => {
      throw new Error("not used");
    },
    fetchBlocks: async () => [],
  };
  return client;
}

function clientThrowing(error: Error): FakeClient {
  const client: FakeClient = {
    calls: 0,
    fetchTelemetry: async () => {
      client.calls += 1;
      throw error;
    },
    fetchMiningAttempts: async (): Promise<MiningAttemptsResponse> => {
      throw new Error("not used");
    },
    fetchBlocks: async () => [],
  };
  return client;
}

describe("fetchTelemetry", () => {
  it("delegates to the injected client exactly once", async () => {
    const client = clientReturning(makeResponse());
    const store = createTelemetryStore({ client });

    await store.getState().fetchTelemetry();

    expect(client.calls).toBe(1);
  });

  it("populates the slim TelemetryResponse shape into state", async () => {
    const store = createTelemetryStore({ client: clientReturning(makeResponse()) });

    await store.getState().fetchTelemetry();

    const s = store.getState();
    expect(s.blocks).toHaveLength(1);
    expect(s.selfAddress).toBe("5GPP");
    expect(s.indexer).toEqual(MOCK_INDEXER);
    expect(s.serverTime).toBe("2026-05-19T12:00:00Z");
    expect(s.chainHead).toEqual(MOCK_CHAIN_HEAD);
    expect(s.babeEpoch).toEqual(MOCK_BABE_EPOCH);
    expect(s.babeAuthorities).toEqual([MOCK_BABE_AUTHORITY]);
    expect(s.chainMiners).toEqual([MOCK_CHAIN_MINER]);
    expect(s.recentDifficulty).toEqual([MOCK_DIFFICULTY]);
    expect(s.validators).toEqual([MOCK_VALIDATOR]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("exposes nodes (NodesSnapshot | null) but not the deleted telemetryIndex field", () => {
    const store = createTelemetryStore({ client: clientReturning(makeResponse()) });
    const s = store.getState() as unknown as Record<string, unknown>;
    expect("nodes" in s).toBe(true);
    expect(s.nodes).toBeNull();
    expect("telemetryIndex" in s).toBe(false);
  });

  it("sets error and clears loading on HTTP failure", async () => {
    const store = createTelemetryStore({ client: clientThrowing(new Error("HTTP 503")) });

    await store.getState().fetchTelemetry();

    const s = store.getState();
    expect(s.error).toBe("HTTP 503");
    expect(s.loading).toBe(false);
  });

  it("sets error and clears loading on network rejection", async () => {
    const store = createTelemetryStore({ client: clientThrowing(new Error("boom")) });

    await store.getState().fetchTelemetry();

    const s = store.getState();
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
  });
});

// ---- selectTipBlock ----------------------------------------------------

describe("selectTipBlock", () => {
  it("returns null for an empty chain", () => {
    expect(selectTipBlock(makeState([]))).toBeNull();
  });

  it("returns blocks[0] — the API ships blocks DESC by substrate block number", () => {
    const state = makeState([
      makeBlock({ substrateBlockNumber: "12" }),
      makeBlock({ substrateBlockNumber: "11" }),
      makeBlock({ substrateBlockNumber: "10" }),
    ]);
    const tip = selectTipBlock(state);
    expect(tip?.substrateBlockNumber).toBe("12");
  });

  it("returns a stable reference (same BlockRecord identity across calls)", () => {
    const state = makeState([makeBlock({ substrateBlockNumber: "7" })]);
    expect(selectTipBlock(state)).toBe(selectTipBlock(state));
  });
});

// ---- selectServerNowMs -------------------------------------------------

describe("selectServerNowMs", () => {
  it("falls back to Date.now() when serverTime is null", () => {
    const before = Date.now();
    const got = selectServerNowMs(makeState([]));
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it("parses serverTime when present", () => {
    const iso = "2026-05-19T12:00:00Z";
    const got = selectServerNowMs(makeState([], { serverTime: iso }));
    expect(got).toBe(Date.parse(iso));
  });
});
