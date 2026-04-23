// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseAdapter } from "../api/db/adapter";
import { SQLiteAdapter } from "../api/db/sqlite";
import type {
  BlockRecord,
  NodeInfo,
  NodesSnapshot,
  TelemetryIndex,
  TelemetryResponse,
} from "../src/types/telemetry";
import { createApp } from "./app";
import type { GeoIpEnricher } from "./geo-ip";

// Keep tests hermetic: never touch the module-level mmdb singleton.
const NOOP_GEOIP: GeoIpEnricher = {
  enabled: false,
  async enrich(n) {
    return n;
  },
  async enrichSnapshot(n) {
    return n;
  },
};

function makeBlock(
  overrides: Partial<BlockRecord> & Pick<BlockRecord, "blockIndex" | "epoch">,
): BlockRecord {
  return {
    blockHash: `hash-${overrides.epoch}-${overrides.blockIndex}`,
    timestamp: 1_700_000_000 + overrides.blockIndex,
    previousHash: `prev-${overrides.blockIndex}`,
    minerId: "miner-1",
    minerCategory: "CPU",
    ecdsaPublicKey: "04deadbeef",
    energy: 0.5,
    diversity: 0.25,
    numValidSolutions: 1,
    miningTime: 10,
    nonce: "42",
    numNodes: 16,
    numEdges: 32,
    difficultyEnergy: 0.4,
    minDiversity: 0.2,
    minSolutions: 1,
    ...overrides,
  };
}

const SNAPSHOT: NodesSnapshot = {
  updatedAt: "2025-01-01T00:00:00.000Z",
  nodeCount: 2,
  activeCount: 1,
  nodes: {
    "node-a": {
      address: "node-a",
      status: "online",
      firstSeen: 1_700_000_000,
      lastSeen: 1_700_000_100,
      lastHeartbeat: 1_700_000_100,
    },
    "node-b": {
      address: "node-b",
      status: "offline",
      firstSeen: 1_700_000_000,
      lastSeen: 1_700_000_050,
      lastHeartbeat: null,
    },
  },
};

let tmpDir: string;
let db: DatabaseAdapter;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "quip-server-test-"));
  db = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: join(tmpDir, "t.db") });
  await db.connect();
  await db.migrate();

  await db.insertBlock(makeBlock({ epoch: "1700000000", blockIndex: 0 }));
  await db.insertBlock(makeBlock({ epoch: "1700000000", blockIndex: 1 }));
  await db.insertBlock(makeBlock({ epoch: "1700000060", blockIndex: 0 }));
  await db.upsertNodes(SNAPSHOT);
  await db.saveCursor({ epoch: "1700000060", blockIndex: 0 }, {});

  app = createApp({ db, enableStatic: false, geoIp: NOOP_GEOIP });
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("server app", () => {
  test("GET /api/telemetry returns seeded blocks and nodes", async () => {
    const res = await app.fetch(new Request("http://test/api/telemetry"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetryResponse;
    expect(body.blocks).toHaveLength(3);
    expect(body.nodes.nodeCount).toBe(2);
    expect(body.nodes.activeCount).toBe(1);
    expect(body.nodes.nodes["node-a"]?.status).toBe("online");
    expect(body.selfAddress).toBeNull();
    // Indexer observability is null until the indexer writes its first
    // snapshot. The test seed does not invoke the indexer.
    expect(body.indexer).toBeNull();
  });

  test("GET /api/telemetry surfaces indexer observability once written", async () => {
    await db.setIndexerObservability({
      nodeLatestEpoch: "1700000060",
      nodeLatestBlockIndex: 42,
      cursorEpoch: "1700000060",
      cursorBlockIndex: 40,
      lastStatusFetchAt: "2026-04-22T12:00:00.000Z",
      lastBlockInsertAt: "2026-04-22T11:58:33.000Z",
    });
    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.indexer).not.toBeNull();
    expect(body.indexer?.nodeLatestBlockIndex).toBe(42);
    expect(body.indexer?.cursorBlockIndex).toBe(40);
    expect(body.indexer?.lastStatusFetchAt).toBe("2026-04-22T12:00:00.000Z");
  });

  test("GET /api/telemetry surfaces the configured self address", async () => {
    await db.setSelfAddress("node-a");
    const res = await app.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.selfAddress).toBe("node-a");
  });

  test("GET /api/telemetry applies geo-IP enrichment when provided", async () => {
    const stubbed: GeoIpEnricher = {
      enabled: true,
      async enrich(n) {
        return n;
      },
      async enrichSnapshot(nodes) {
        const out: Record<string, NodeInfo> = {};
        for (const [addr, info] of Object.entries(nodes)) {
          out[addr] = {
            ...info,
            location: { country: "US", city: "New York", lat: 40.7, lng: -74.0 },
          };
        }
        return out;
      },
    };
    const appWithGeo = createApp({ db, enableStatic: false, geoIp: stubbed });
    const res = await appWithGeo.fetch(new Request("http://test/api/telemetry"));
    const body = (await res.json()) as TelemetryResponse;
    expect(body.nodes.nodes["node-a"]?.location?.country).toBe("US");
    expect(body.nodes.nodes["node-b"]?.location?.lat).toBe(40.7);
  });

  test("GET /api/telemetry/epochs/:epoch filters by epoch", async () => {
    const res = await app.fetch(new Request("http://test/api/telemetry/epochs/1700000000"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: BlockRecord[] };
    expect(body.blocks).toHaveLength(2);
    for (const b of body.blocks) expect(b.epoch).toBe("1700000000");
  });

  test("GET /api/telemetry/epochs rejects a non-hex epoch id", async () => {
    // Post-v4 epoch IDs are hex hashes; anything outside /^[0-9a-f]{8,64}$/i
    // is rejected before the DB roundtrip.
    const res = await app.fetch(new Request("http://test/api/telemetry/epochs/not-a-hash"));
    expect(res.status).toBe(400);
  });

  test("GET /api/health returns cursor and lastSync", async () => {
    const res = await app.fetch(new Request("http://test/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      cursor: { epoch: string | null; blockIndex: number };
      lastSync: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.cursor.epoch).toBe("1700000060");
    expect(body.cursor.blockIndex).toBe(0);
    expect(body.lastSync).toBe(SNAPSHOT.updatedAt);
  });

  test("GET /api/telemetry/index returns epoch list", async () => {
    const res = await app.fetch(new Request("http://test/api/telemetry/index"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetryIndex;
    const epochs = body.epochs.map((e) => e.epoch).sort();
    expect(epochs).toEqual(["1700000000", "1700000060"]);
    const first = body.epochs.find((e) => e.epoch === "1700000000");
    expect(first?.blockCount).toBe(2);
  });
});
