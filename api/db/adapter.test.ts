// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { isLocalDeployment, parseIndexerObservability, toMinerCategory } from "./adapter";

describe("toMinerCategory", () => {
  it("accepts bare CPU/GPU/QPU from /nodes", () => {
    expect(toMinerCategory("CPU")).toBe("CPU");
    expect(toMinerCategory("GPU")).toBe("GPU");
    expect(toMinerCategory("QPU")).toBe("QPU");
  });

  it("extracts the prefix from compound block miner_type values", () => {
    // Seen in the wild on block payloads: "<category>-<variant>:<index>".
    expect(toMinerCategory("GPU-LOCAL:0")).toBe("GPU");
    expect(toMinerCategory("GPU-CUDA:1")).toBe("GPU");
    expect(toMinerCategory("CPU-LOCAL")).toBe("CPU");
    expect(toMinerCategory("QPU-DWAVE:0")).toBe("QPU");
  });

  it("normalizes case", () => {
    expect(toMinerCategory("gpu-local:0")).toBe("GPU");
  });

  it("throws on unknown prefixes so we do not silently map garbage to a category", () => {
    expect(() => toMinerCategory("TPU")).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory("FOO-BAR:0")).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory(null)).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory(42)).toThrow(/Unknown miner category/);
  });

  it("parses the legacy capability-map string form", () => {
    // Oldest miners serialized a capability object as a JSON string.
    const cpuOnly = '{"cpu": {"num_cpus": 2}, "gpu": null, "qpu": null}';
    expect(toMinerCategory(cpuOnly)).toBe("CPU");
  });

  it("parses the legacy config-dump string form and picks highest capability", () => {
    // Middle-generation miners accidentally serialized their whole node
    // config into miner_type. We recover category from capability hints.
    const gpuDump =
      '{"genesis_config": "g.json", "node_name": "gpu-1", "gpu": {"yielding": true}, "cuda": {"0": {}}}';
    expect(toMinerCategory(gpuDump)).toBe("GPU");

    const qpuDump =
      '{"node_name": "qpu1", "qpu": {}, "dwave": {"solver": "Advantage2_system1.13"}}';
    expect(toMinerCategory(qpuDump)).toBe("QPU");

    const cpuDump = '{"node_name": "cpu-1", "cpu": {"num_cpus": 12}}';
    expect(toMinerCategory(cpuDump)).toBe("CPU");
  });

  it("infers GPU from metal key (Apple Silicon miners)", () => {
    expect(toMinerCategory('{"node_name": "mac", "cpu": {"num_cpus": 1}, "metal": {}}')).toBe(
      "GPU",
    );
  });

  it("infers QPU when only dwave is present without qpu key", () => {
    expect(toMinerCategory('{"dwave": {"solver": "x"}}')).toBe("QPU");
  });

  it("picks highest capability from compound multi-backend strings", () => {
    // Observed on some nodes running multiple miner backends simultaneously.
    expect(toMinerCategory("CPU[1]+EXTERNAL[2]")).toBe("CPU");
    expect(toMinerCategory("CPU[2]+GPU[1]")).toBe("GPU");
    expect(toMinerCategory("CPU[1]+QPU[1]")).toBe("QPU");
    // Order does not matter — we scan every segment.
    expect(toMinerCategory("EXTERNAL[2]+CPU[1]")).toBe("CPU");
    expect(toMinerCategory("GPU[1]+CPU[2]")).toBe("GPU");
  });

  it("does not match substrings — only full category tokens", () => {
    // Guard against false positives like "SUPERCPU" accidentally mapping to CPU.
    expect(() => toMinerCategory("SUPERCPU")).toThrow(/Unknown miner category/);
    expect(() => toMinerCategory("MYGPUX")).toThrow(/Unknown miner category/);
  });
});

describe("isLocalDeployment", () => {
  it("always returns true for sqlite", () => {
    expect(isLocalDeployment({ adapter: "sqlite" })).toBe(true);
    expect(isLocalDeployment({ adapter: "sqlite", sqlitePath: "/data/t.db" })).toBe(true);
  });

  it("returns true for Postgres on known local hostnames", () => {
    for (const host of ["localhost", "127.0.0.1", "db", "postgres"]) {
      expect(
        isLocalDeployment({
          adapter: "postgres",
          databaseUrl: `postgresql://u:p@${host}:5432/quip`,
        }),
      ).toBe(true);
    }
  });

  it("returns false for remote Postgres (e.g. Supabase)", () => {
    expect(
      isLocalDeployment({
        adapter: "postgres",
        databaseUrl: "postgresql://u:p@db.xyz.supabase.co:5432/postgres",
      }),
    ).toBe(false);
    expect(
      isLocalDeployment({
        adapter: "postgres",
        databaseUrl: "postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
      }),
    ).toBe(false);
  });

  it("returns false for Postgres without a URL", () => {
    expect(isLocalDeployment({ adapter: "postgres" })).toBe(false);
  });

  it("returns false for malformed Postgres URLs rather than throwing", () => {
    expect(isLocalDeployment({ adapter: "postgres", databaseUrl: "not a url" })).toBe(false);
  });
});

describe("parseIndexerObservability", () => {
  it("parses a valid v5 blob with substrate fields", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      tipEpoch: "abc123",
      tipBlockIndex: 42,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      nodesObservedAt: "2026-04-23T00:00:30.000Z",
      lastSubstrateEventAt: "2026-05-15T00:00:00.000Z",
      bestBlockHeight: "12345",
      finalizedBlockHeight: "12343",
      chainConnected: true,
    });
    const parsed = parseIndexerObservability(blob, "sqlite");
    expect(parsed).not.toBeNull();
    expect(parsed!.tipEpoch).toBe("abc123");
    expect(parsed!.backfillEpoch).toBeNull();
    expect(parsed!.backfillBlockIndex).toBe(0);
    expect(parsed!.chainConnected).toBe(true);
    expect(parsed!.bestBlockHeight).toBe("12345");
    expect(parsed!.lastSubstrateEventAt).toBe("2026-05-15T00:00:00.000Z");
    expect(parsed!.nodesObservedAt).toBe("2026-04-23T00:00:30.000Z");
  });

  it("rejects v4 blobs missing substrate fields (forces refresh on first poll)", () => {
    const v4Blob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      tipEpoch: "abc123",
      tipBlockIndex: 42,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    expect(parseIndexerObservability(v4Blob, "sqlite")).toBeNull();
  });

  it("rejects blobs missing nodesObservedAt (audit #6)", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      // nodesObservedAt: missing
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });

  it("rejects old-shape blobs (cursorEpoch/cursorBlockIndex)", () => {
    const oldBlob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      cursorEpoch: "abc123",
      cursorBlockIndex: 42,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    expect(parseIndexerObservability(oldBlob, "sqlite")).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseIndexerObservability("{not json", "sqlite")).toBeNull();
  });

  it("rejects blobs missing backfill fields", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });

  it("rejects blobs with non-boolean chainConnected", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: "yes", // wrong type
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });
});
