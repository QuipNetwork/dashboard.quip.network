// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import type { NodeDescriptorRecord, NodeMinerEntry } from "@quip/shared/telemetry";

import {
  countDevicesByType,
  normalizeSeriesByDeviceCount,
  type DeviceCounts,
} from "./device-counts";
import type { BlocksOverTimeSeries } from "./use-blocks-over-time";

function descriptorRecord(
  accountId: string,
  miners: Record<string, NodeMinerEntry> | undefined,
): NodeDescriptorRecord {
  return {
    accountId,
    blockNumber: "1",
    blockHash: "0xblock",
    extrinsicIndex: 0,
    blockTimestamp: 0,
    firstBlockTimestamp: 0,
    observedAt: "2026-01-01T00:00:00Z",
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: accountId,
      miners,
    },
  };
}

describe("countDevicesByType", () => {
  test("CPU entry with numCpus 6 contributes 6", () => {
    const record = descriptorRecord("cpu-node", {
      "cpu-1": { kind: "CPU", minerId: "cpu-1", numCpus: 6 },
    });
    expect(countDevicesByType([record]).CPU).toBe(6);
  });

  test("CPU entry without numCpus falls back to 1", () => {
    const record = descriptorRecord("cpu-node", { "cpu-1": { kind: "CPU", minerId: "cpu-1" } });
    expect(countDevicesByType([record]).CPU).toBe(1);
  });

  test("multi-GPU descriptor counts one device per GPU-kind entry", () => {
    const record = descriptorRecord("gpu-node", {
      "gpu-1": { kind: "GPU", minerId: "gpu-1" },
      "gpu-2": { kind: "GPU", minerId: "gpu-2" },
    });
    expect(countDevicesByType([record]).GPU).toBe(2);
  });

  test("QPU entry contributes 1", () => {
    const record = descriptorRecord("qpu-node", { "qpu-1": { kind: "QPU", minerId: "qpu-1" } });
    expect(countDevicesByType([record]).QPU).toBe(1);
  });

  test("empty descriptors list yields zero counts for every type", () => {
    expect(countDevicesByType([])).toEqual({ CPU: 0, GPU: 0, QPU: 0, OTHER: 0 });
  });

  test("descriptors without a miners map contribute nothing", () => {
    const record = descriptorRecord("bare-node", undefined);
    expect(countDevicesByType([record])).toEqual({ CPU: 0, GPU: 0, QPU: 0, OTHER: 0 });
  });

  test("counts accumulate across multiple descriptors", () => {
    const records = [
      descriptorRecord("cpu-a", { "cpu-a-1": { kind: "CPU", minerId: "cpu-a-1", numCpus: 4 } }),
      descriptorRecord("cpu-b", { "cpu-b-1": { kind: "CPU", minerId: "cpu-b-1", numCpus: 2 } }),
    ];
    expect(countDevicesByType(records).CPU).toBe(6);
  });
});

describe("normalizeSeriesByDeviceCount", () => {
  test("divides a type's cumulative counts by its device count", () => {
    const series: BlocksOverTimeSeries[] = [
      {
        id: "CPU",
        data: [
          { x: 0, y: 2 },
          { x: 1, y: 10 },
        ],
      },
    ];
    const counts: DeviceCounts = { CPU: 2, GPU: 0, QPU: 0, OTHER: 0 };
    expect(normalizeSeriesByDeviceCount(series, counts)).toEqual([
      {
        id: "CPU",
        data: [
          { x: 0, y: 1 },
          { x: 1, y: 5 },
        ],
      },
    ]);
  });

  test("omits a type with zero registered devices instead of dividing by zero", () => {
    const series: BlocksOverTimeSeries[] = [{ id: "QPU", data: [{ x: 0, y: 5 }] }];
    const counts: DeviceCounts = { CPU: 0, GPU: 0, QPU: 0, OTHER: 0 };
    const result = normalizeSeriesByDeviceCount(series, counts);
    expect(result).toEqual([]);
    expect(result.some((s) => s.data.some((p) => !Number.isFinite(p.y)))).toBe(false);
  });

  test("leaves other types' series untouched when only one type has devices", () => {
    const series: BlocksOverTimeSeries[] = [
      { id: "CPU", data: [{ x: 0, y: 4 }] },
      { id: "GPU", data: [{ x: 0, y: 9 }] },
    ];
    const counts: DeviceCounts = { CPU: 2, GPU: 0, QPU: 0, OTHER: 0 };
    expect(normalizeSeriesByDeviceCount(series, counts)).toEqual([
      { id: "CPU", data: [{ x: 0, y: 2 }] },
    ]);
  });
});
