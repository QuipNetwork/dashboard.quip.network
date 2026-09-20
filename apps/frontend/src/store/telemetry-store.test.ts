// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { TelemetryClient } from "@/services/telemetry-client";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  CurrentDispatch,
  DifficultyRecord,
  IndexerObservability,
  MiningAttemptsResponse,
  TelemetryResponse,
  ValidatorAuthorshipRecord,
} from "@quip/shared/telemetry";
import {
  createTelemetryStore,
  mergeWonBlocks,
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
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: false,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

const MOCK_CHAIN_HEAD: ChainHead = {
  bestBlockNumber: "100",
  bestBlockHash: "0xbest",
  finalizedBlockNumber: "97",
  finalizedBlockHash: "0xfin",
  finalityLag: 3,
  qblockCount: 99,
  currentQBlockId: "100",
  currentQBlockParticipants: 5,
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
  topologyHash: null,
  source: "poll",
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
    mineableTopologies: [],
    validators: [MOCK_VALIDATOR],
    nodes: null,
    nodeDescriptors: [],
    recentMiningSubmissions: [],
    selfProblemsAttempted: 0,
    files: { qblocksManifest: "/files/qblocks/metadata.json", minerCurrentDispatch: null },
    ...overrides,
  };
}

function makeState(blocks: BlockRecord[], overrides: Partial<TelemetryState> = {}): TelemetryState {
  return {
    blocks,
    wonBlocks: blocks,
    selfAddress: null,
    indexer: null,
    serverTime: null,
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
    participationCompute: [],
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
    fetchNodeLive: () => new Promise<never>(() => {}),
    fetchDifficultyHistory: () => new Promise<never>(() => {}),
    fetchMinerWins: () => new Promise<never>(() => {}),
    fetchNodeSummary: () => new Promise<never>(() => {}),
    fetchMiningHistory: () => new Promise<never>(() => {}),
    fetchQblocks: async () => ({
      rows: [
        {
          qblockId: "1",
          account: "5GPP",
          kind: "Cpu",
          miningSeconds: 60,
          exactQpuAccessUs: null,
        },
      ],
      winners: [],
      history: [],
    }),
    fetchQblockHistoryDay: async () => ({ rows: [], winners: [] }),
    fetchMinerCurrentDispatch: async () => null,
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
    fetchNodeLive: () => new Promise<never>(() => {}),
    fetchDifficultyHistory: () => new Promise<never>(() => {}),
    fetchMinerWins: () => new Promise<never>(() => {}),
    fetchNodeSummary: () => new Promise<never>(() => {}),
    fetchMiningHistory: () => new Promise<never>(() => {}),
    fetchQblocks: async () => ({ rows: [], winners: [], history: [] }),
    fetchQblockHistoryDay: async () => ({ rows: [], winners: [] }),
    fetchMinerCurrentDispatch: async () => null,
  };
  return client;
}

describe("qblock history", () => {
  it("walks history days in the background after the first load", async () => {
    const row = (qblockId: string) => ({
      qblockId,
      account: "5GPP",
      kind: "Cpu",
      miningSeconds: 60,
      exactQpuAccessUs: null,
    });
    const winner = (qblockId: string) =>
      makeBlock({ blockHash: `0x${qblockId}`, qblockId, substrateBlockNumber: qblockId });
    const loaded: string[] = [];
    const client: FakeClient = {
      ...clientReturning(makeResponse({ blocks: [winner("3")] })),
      fetchQblocks: async () => ({
        rows: [row("3")],
        winners: [winner("3")],
        history: ["d2", "d1"],
      }),
      fetchQblockHistoryDay: async (day: string) => {
        loaded.push(day);
        return day === "d2"
          ? { rows: [row("2"), row("3")], winners: [winner("2"), winner("3")] }
          : {
              rows: [row("1"), row("2"), row("3")],
              winners: [winner("1"), winner("2"), winner("3")],
            };
      },
    };
    const store = createTelemetryStore({ client });
    await store.getState().fetchTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded).toEqual(["d2", "d1"]);
    expect(store.getState().participationCompute.map((r) => r.qblockId)).toEqual(["1", "2", "3"]);
    expect(store.getState().blocks.map((b) => b.qblockId)).toEqual(["3"]);
    expect(store.getState().wonBlocks.map((b) => b.qblockId)).toEqual(["3", "2", "1"]);
  });

  it("keeps loaded history winners when a later manifest fetch fails", async () => {
    let manifestFails = false;
    const client: FakeClient = {
      ...clientReturning(makeResponse({ blocks: [makeBlock({ blockHash: "0xtip" })] })),
      fetchQblocks: async () => {
        if (manifestFails) throw new Error("HTTP 404");
        return {
          rows: [],
          winners: [makeBlock({ blockHash: "0xold", substrateBlockNumber: "7" })],
          history: [],
        };
      },
    };
    const store = createTelemetryStore({ client });
    await store.getState().fetchTelemetry();
    manifestFails = true;
    await store.getState().fetchTelemetry();
    expect(store.getState().wonBlocks.map((b) => b.blockHash)).toEqual(["0xtip", "0xold"]);
  });
});

describe("mergeWonBlocks", () => {
  it("unions by block hash, newest substrate block first, preferring the telemetry copy", () => {
    const telemetry = makeBlock({ blockHash: "0xb", substrateBlockNumber: "20", finalized: true });
    const merged = mergeWonBlocks(
      [telemetry],
      [
        makeBlock({ blockHash: "0xa", substrateBlockNumber: "9" }),
        makeBlock({ blockHash: "0xb", substrateBlockNumber: "20", finalized: false }),
        makeBlock({ blockHash: "0xc", substrateBlockNumber: "100" }),
      ],
    );
    expect(merged.map((b) => b.blockHash)).toEqual(["0xc", "0xb", "0xa"]);
    expect(merged[1]).toBe(telemetry);
  });
});

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
    expect(s.participationCompute).toEqual([
      { qblockId: "1", account: "5GPP", kind: "Cpu", miningSeconds: 60, exactQpuAccessUs: null },
    ]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("fetches the miner's current dispatch from the file the response points at", async () => {
    const dispatch: CurrentDispatch = {
      solutionNumber: 7,
      status: "in-flight",
      attempts: [
        { iter: 1, bestEnergyMilli: -14200, resultKind: "stored", minerType: "CPU", extra: {} },
      ],
    };
    const calls: string[] = [];
    const client: FakeClient = {
      ...clientReturning(
        makeResponse({
          files: {
            qblocksManifest: "/files/qblocks/metadata.json",
            minerCurrentDispatch: "/files/miners/5GPP/current-dispatch.json",
          },
        }),
      ),
      fetchMinerCurrentDispatch: async (url: string) => {
        calls.push(url);
        return dispatch;
      },
    };
    const store = createTelemetryStore({ client });

    await store.getState().fetchTelemetry();

    expect(calls).toEqual(["/files/miners/5GPP/current-dispatch.json"]);
    expect(store.getState().currentDispatch).toEqual(dispatch);
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

// resolveServerNowMs / useServerNowMs live in ./use-server-now-ms.test.tsx
// (they need a React render to prove the no-loop regression, bead mrt).
