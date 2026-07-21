// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import type {
  ChainMinerRecord,
  NodeDescriptorRecord,
  NodeMinerEntry,
} from "@quip/shared/telemetry";

function chainMiner(
  accountId: string,
  hardware: ChainMinerRecord["hardware"] = null,
): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "1",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware,
  };
}

function descriptor(
  accountId: string,
  miners: Record<string, NodeMinerEntry>,
): NodeDescriptorRecord {
  return {
    accountId,
    blockNumber: "1",
    blockHash: "0x",
    extrinsicIndex: 0,
    blockTimestamp: 0,
    firstBlockTimestamp: 0,
    observedAt: "2026-07-05T00:00:00Z",
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: "rig",
      miners,
    },
  };
}

function miner(kind: NodeMinerEntry["kind"], minerId: string): NodeMinerEntry {
  return { kind, minerId };
}

describe("buildMinerCategoryIndex — capability-priority classification", () => {
  test("a rig with any GPU miner classifies as GPU even when CPU workers dominate by count", () => {
    // The Tesla-node case: 6 CPU workers + 1 GPU/MPS miner. Count-dominant
    // would (wrongly) pick CPU; capability-priority picks GPU.
    const miners: Record<string, NodeMinerEntry> = {
      "cpu.0": miner("CPU", "a-CPU-1"),
      "cpu.1": miner("CPU", "a-CPU-2"),
      "cpu.2": miner("CPU", "a-CPU-3"),
      "cpu.3": miner("CPU", "a-CPU-4"),
      "cpu.4": miner("CPU", "a-CPU-5"),
      "cpu.5": miner("CPU", "a-CPU-6"),
      "metal.0": miner("GPU", "a-GPU-MPS"),
    };
    const idx = buildMinerCategoryIndex([chainMiner("acct-a")], [descriptor("acct-a", miners)]);
    expect(categoryFor("acct-a", idx)).toBe("GPU");
  });

  test("priority order GPU > QPU > CPU: QPU wins over CPU when no GPU present", () => {
    const miners: Record<string, NodeMinerEntry> = {
      "cpu.0": miner("CPU", "b-CPU-1"),
      "qpu.0": miner("QPU", "b-QPU-1"),
    };
    const idx = buildMinerCategoryIndex([chainMiner("acct-b")], [descriptor("acct-b", miners)]);
    expect(categoryFor("acct-b", idx)).toBe("QPU");
  });

  test("CPU-only rig classifies as CPU", () => {
    const idx = buildMinerCategoryIndex(
      [chainMiner("acct-c")],
      [descriptor("acct-c", { "cpu.0": miner("CPU", "c-CPU-1") })],
    );
    expect(categoryFor("acct-c", idx)).toBe("CPU");
  });

  test("account with no hardware or descriptor falls through to OTHER", () => {
    const idx = buildMinerCategoryIndex([chainMiner("acct-d")], []);
    expect(categoryFor("acct-d", idx)).toBe("OTHER");
  });
});
