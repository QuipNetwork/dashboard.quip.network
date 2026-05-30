// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  TelemetryResponse,
  ValidatorAuthorshipRecord,
} from "../types/telemetry";
import {
  selectServerNowMs,
  selectTipBlock,
  type TelemetryState,
  useTelemetryStore,
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

// ---- fetch() mocking ---------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface FetchCall {
  url: string;
  init: FetchInit;
}

const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

function installFetchMock(handler: (url: string) => Response | Promise<Response>): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
}

function resetStore(): void {
  useTelemetryStore.setState({
    blocks: [],
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
    loading: true,
    error: null,
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- fetchTelemetry: endpoint contract ---------------------------------

describe("fetchTelemetry", () => {
  it("issues exactly one request to /api/telemetry (no index endpoint)", async () => {
    installFetchMock(() => new Response(JSON.stringify(makeResponse()), { status: 200 }));

    await useTelemetryStore.getState().fetchTelemetry();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("/api/telemetry");
  });

  it("populates the slim TelemetryResponse shape into state", async () => {
    installFetchMock(() => new Response(JSON.stringify(makeResponse()), { status: 200 }));

    await useTelemetryStore.getState().fetchTelemetry();

    const s = useTelemetryStore.getState();
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
    const s = useTelemetryStore.getState() as unknown as Record<string, unknown>;
    expect("nodes" in s).toBe(true);
    expect(s.nodes).toBeNull();
    // PoW-epoch abstraction stayed deleted per the v0.2 resurrection plan.
    expect("telemetryIndex" in s).toBe(false);
  });

  it("sets error and clears loading on HTTP failure", async () => {
    installFetchMock(() => new Response("nope", { status: 503 }));

    await useTelemetryStore.getState().fetchTelemetry();

    const s = useTelemetryStore.getState();
    expect(s.error).toBe("HTTP 503");
    expect(s.loading).toBe(false);
  });

  it("sets error and clears loading on network rejection", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await useTelemetryStore.getState().fetchTelemetry();

    const s = useTelemetryStore.getState();
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
