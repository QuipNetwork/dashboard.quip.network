// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  BlockRecord,
  ChainMinerRecord,
  MinerHardwareRecord,
  MiningSubmissionRecord,
} from "@/types/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import { useComputeUsed, type ComputeUsedEntry } from "./use-compute-used";

// ---- Fixtures ----------------------------------------------------------

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GCpu",
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

function makeHardware(overrides: Partial<MinerHardwareRecord>): MinerHardwareRecord {
  return {
    accountId: "5GCpu",
    nodeId: "node-1",
    miners: [{ id: "node-1-CPU-1", type: "CPU" }],
    primaryType: "CPU",
    source: "self",
    observedAt: "2026-05-26T00:00:00Z",
    ...overrides,
  };
}

function makeChainMiner(overrides: Partial<ChainMinerRecord> = {}): ChainMinerRecord {
  return {
    accountId: "5GCpu",
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: makeHardware({}),
    ...overrides,
  };
}

function makeSubmission(overrides: Partial<MiningSubmissionRecord>): MiningSubmissionRecord {
  return {
    solutionNumber: 1,
    minerId: "5GQpu",
    minerType: "QPU",
    tsNs: "0",
    energyMilli: -14000000,
    diversityMilli: 250,
    thresholdMilli: -14910591,
    lastProofBlockHash: "0xabc",
    extrinsicHash: null,
    chainBlockHash: null,
    chainBlockNumber: null,
    powSequence: null,
    outcome: "submitted_inblock",
    attemptCount: 2,
    bestEnergyMilli: -14000000,
    numValid: 5,
    qpuAccessTimeUs: 0,
    observedAt: "2026-05-26T00:00:00Z",
    ...overrides,
  };
}

// ---- Harness -----------------------------------------------------------

function renderHook(): { current: ComputeUsedEntry[] } {
  const result: { current: ComputeUsedEntry[] } = { current: [] };

  function Probe(): null {
    result.current = useComputeUsed();
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

  return result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Reset both stores to a known baseline each test. byType + all
  // three categories selected lines up with the default
  // NetworkView chart layout.
  useTelemetryStore.setState({
    blocks: [],
    chainMiners: [],
    nodeDescriptors: [],
    recentMiningSubmissions: [],
  });
  useUIStore.setState({ aggregationMode: "byType", selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---- Tests -------------------------------------------------------------

describe("useComputeUsed", () => {
  test("CPU bar accumulates wall-clock miningTime per block", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xc1", minerId: "5GCpu", miningTime: 60 }),
        makeBlock({ blockHash: "0xc2", minerId: "5GCpu", miningTime: 30 }),
      ],
      chainMiners: [makeChainMiner({ accountId: "5GCpu", hardware: makeHardware({}) })],
    });

    const cpu = renderHook().current.find((e) => e.minerType === "CPU");
    expect(cpu?.compute).toBe(90);
  });

  test("QPU bar uses qpu_access_time_us from the matching submission, not wall-clock", () => {
    // Critical regression coverage. Before this fix the QPU bar
    // added block.miningTime (wall-clock seconds dominated by
    // D-Wave RTT) — overstating by 100x+. Now: the bar pulls
    // qpu_access_time_us joined by chain_block_number from
    // mining_submissions and converts microseconds → seconds.
    useTelemetryStore.setState({
      blocks: [
        makeBlock({
          blockHash: "0xq1",
          substrateBlockNumber: "200",
          minerId: "5GQpu",
          miningTime: 1200, // 20-minute wall-clock — would have been the impostor
        }),
      ],
      chainMiners: [
        makeChainMiner({
          accountId: "5GQpu",
          hardware: makeHardware({
            accountId: "5GQpu",
            primaryType: "QPU",
            miners: [{ id: "qpu-1", type: "QPU" }],
          }),
        }),
      ],
      recentMiningSubmissions: [
        makeSubmission({
          minerId: "5GQpu",
          chainBlockNumber: "200",
          qpuAccessTimeUs: 84_000, // 0.084s — realistic D-Wave qpu_access_time
        }),
      ],
    });

    const qpu = renderHook().current.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBeCloseTo(0.084, 6);
  });

  test("QPU blocks with no matching mining_submissions row are excluded entirely", () => {
    // Other operators' QPU wins land in `blocks` but we have no
    // iteration data for them — undercounting (skip) is the right
    // call here. Counting wall-clock would overstate by 100x+ and
    // re-introduce the bug we just fixed.
    useTelemetryStore.setState({
      blocks: [
        makeBlock({
          blockHash: "0xq1",
          substrateBlockNumber: "200",
          minerId: "5GOtherQpu",
          miningTime: 1500,
        }),
      ],
      chainMiners: [
        makeChainMiner({
          accountId: "5GOtherQpu",
          hardware: makeHardware({
            accountId: "5GOtherQpu",
            primaryType: "QPU",
            miners: [{ id: "qpu-other", type: "QPU" }],
          }),
        }),
      ],
      recentMiningSubmissions: [], // no local data for this miner
    });

    const qpu = renderHook().current.find((e) => e.minerType === "QPU");
    // Type was requested but no rows survived the filter → no entry.
    expect(qpu).toBeUndefined();
  });

  test("CPU/GPU bars are unaffected by missing mining_submissions data", () => {
    // The qpuAccessTimeUs path is QPU-only — CPU/GPU miners that
    // never write to mining_submissions still account for their
    // wall-clock time. This guards against a regression where the
    // filter accidentally caught all types.
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xc1", minerId: "5GCpu", miningTime: 100 }),
        makeBlock({
          blockHash: "0xg1",
          minerId: "5GGpu",
          miningTime: 50,
        }),
      ],
      chainMiners: [
        makeChainMiner({ accountId: "5GCpu", hardware: makeHardware({}) }),
        makeChainMiner({
          accountId: "5GGpu",
          hardware: makeHardware({
            accountId: "5GGpu",
            primaryType: "GPU",
            miners: [{ id: "gpu-1", type: "GPU" }],
          }),
        }),
      ],
      recentMiningSubmissions: [],
    });

    const entries = renderHook().current;
    expect(entries.find((e) => e.minerType === "CPU")?.compute).toBe(100);
    expect(entries.find((e) => e.minerType === "GPU")?.compute).toBe(50);
  });
});
