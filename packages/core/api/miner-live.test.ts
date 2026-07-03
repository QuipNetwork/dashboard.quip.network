// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  narrowMinerType,
  parseMinerStatsPayload,
  parseStatusModes,
  parseStatusPrimaryMinerId,
} from "./miner-live";

describe("narrowMinerType", () => {
  test("maps bare categories case-insensitively", () => {
    expect(narrowMinerType("CPU")).toBe("CPU");
    expect(narrowMinerType("cpu")).toBe("CPU");
    expect(narrowMinerType("QPU")).toBe("QPU");
  });

  test("maps backend-qualified types to their category prefix", () => {
    // The upstream miner reports one type string per backend
    // (quip-protocol shared/miner_worker.py `miner_type`).
    expect(narrowMinerType("GPU-MPS")).toBe("GPU"); // metal
    expect(narrowMinerType("GPU-LOCAL:0")).toBe("GPU"); // cuda
    expect(narrowMinerType("GPU-T4")).toBe("GPU"); // modal
    expect(narrowMinerType("GPU-CUDA-Gibbs")).toBe("GPU"); // cuda-gibbs
    expect(narrowMinerType("gpu-mps")).toBe("GPU");
  });

  test("unknown kinds and prefix look-alikes fall to OTHER", () => {
    expect(narrowMinerType("GPUX")).toBe("OTHER");
    expect(narrowMinerType("FPGA")).toBe("OTHER");
    expect(narrowMinerType(undefined)).toBe("OTHER");
    expect(narrowMinerType("")).toBe("OTHER");
  });
});

describe("parseMinerStatsPayload", () => {
  test("reads controller counters from a /api/v1/stats payload", () => {
    const stats = parseMinerStatsPayload({
      controller: {
        heads_observed: 10,
        contexts_dispatched: 9,
        results_received: 8,
        proofs_submitted: 5,
        stale_drops: 2,
        submission_errors: 1,
        duplicate_result_drops: 3,
      },
    });
    expect(stats).toEqual({
      headsObserved: 10,
      contextsDispatched: 9,
      resultsReceived: 8,
      proofsSubmitted: 5,
      staleDrops: 2,
      submissionErrors: 1,
      duplicateResultDrops: 3,
    });
  });

  test("defaults missing counters to 0", () => {
    expect(parseMinerStatsPayload({})).toEqual({
      headsObserved: 0,
      contextsDispatched: 0,
      resultsReceived: 0,
      proofsSubmitted: 0,
      staleDrops: 0,
      submissionErrors: 0,
      duplicateResultDrops: 0,
    });
  });
});

describe("parseStatusModes", () => {
  test("parses the per-backend breakdown from /api/v1/status", () => {
    const modes = parseStatusModes({
      cpu: {
        controller: { heads_observed: 4, proofs_submitted: 5 },
        miners: [{ id: "cpu-1", type: "cpu" }],
      },
    });
    expect(modes.cpu?.proofsSubmitted).toBe(5);
    expect(modes.cpu?.headsObserved).toBe(4);
    expect(modes.cpu?.miners).toEqual([{ id: "cpu-1", type: "CPU" }]);
  });

  test("returns an empty record for legacy/single-process miners", () => {
    expect(parseStatusModes(undefined)).toEqual({});
    expect(parseStatusModes(null)).toEqual({});
  });
});

describe("parseStatusPrimaryMinerId", () => {
  test("returns the first declared miner's id", () => {
    expect(parseStatusPrimaryMinerId({ miners: [{ id: "node-1-CPU-1", type: "cpu" }] })).toBe(
      "node-1-CPU-1",
    );
  });

  test("null when no miners are declared", () => {
    expect(parseStatusPrimaryMinerId({ miners: [] })).toBeNull();
    expect(parseStatusPrimaryMinerId({})).toBeNull();
  });
});
