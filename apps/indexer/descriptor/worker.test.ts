// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { NodeDescriptor } from "@quip/shared/telemetry";

import { IndexerState } from "../core/state";
import { FakeSubstrateClient, type MinerRegistryDescriptorRecord } from "../clients/substrate-client";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";
import { DescriptorWorker, type DescriptorWorkerDeps } from "./worker";

// Tiny scan interval keeps the timer-driven loop fast under test.
const runDescriptorLoop = (deps: DescriptorWorkerDeps, signal: AbortSignal): Promise<void> =>
  new DescriptorWorker({ scanIntervalMs: 10, ...deps }).run(signal);

const VALID_DESCRIPTOR: NodeDescriptor = {
  schema: "quip.node_descriptor.v1",
  descriptorVersion: 1,
  nodeName: "rig-test",
  runtime: { quipVersion: "0.2.0" },
};

function makeDescriptor(
  overrides: Partial<MinerRegistryDescriptorRecord> = {},
): MinerRegistryDescriptorRecord {
  return {
    accountId: "5GPP",
    blockNumber: "100",
    blockHash: "0xabc",
    blockTimestamp: 1_700_000_000,
    descriptor: VALID_DESCRIPTOR,
    ...overrides,
  };
}

let db: DatabaseAdapter;
let client: FakeSubstrateClient;

beforeEach(async () => {
  db = await newInMemoryAdapter();
  client = new FakeSubstrateClient();
  await client.connect();
});

afterEach(async () => {
  await client.disconnect();
  await db.disconnect();
});

describe("DescriptorWorker (finalized-head snapshot)", () => {
  it("snapshots the registry at the finalized head and upserts every descriptor", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "500";
    // A single head-state read returns every account's current descriptor,
    // each carrying its own on-chain provenance block (not the scan block).
    client.minerRegistryDescriptorsByBlock.set("500", [
      makeDescriptor({ blockNumber: "120", accountId: "5AAA" }),
      makeDescriptor({ blockNumber: "480", accountId: "5BBB" }),
    ]);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await runDescriptorLoop(
      { config: makeConfig(), db, state, urls: ["ws://x"], clientFactory: () => client },
      ac.signal,
    );

    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId).sort()).toEqual(["5AAA", "5BBB"]);
    expect(await db.getDescriptorCheckpoint()).toBe("500");
  });

  it("STRESS: scan cost is independent of head height (no per-block walk)", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "50000";
    const scanned: string[] = [];
    const realScan = client.getMinerRegistryDescriptorsAt.bind(client);
    client.getMinerRegistryDescriptorsAt = async (n: string) => {
      scanned.push(n);
      return realScan(n);
    };
    client.minerRegistryDescriptorsByBlock.set("50000", [
      makeDescriptor({ accountId: "5HEAD", blockNumber: "49000" }),
    ]);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await runDescriptorLoop(
      {
        config: makeConfig(),
        db,
        state,
        urls: ["ws://x"],
        clientFactory: () => client,
        scanIntervalMs: 20,
      },
      ac.signal,
    );

    // The old block-by-block drain would issue ~50000 registry reads (one per
    // block from genesis to head); the head snapshot issues one per tick and
    // only ever reads the finalized head.
    console.log(
      `[stress] head=50000: block-walk would scan 50000 blocks; ` +
        `head-snapshot scanned ${scanned.length} (always the head)`,
    );
    expect(scanned.every((b) => b === "50000")).toBe(true);
    expect(scanned.length).toBeLessThan(10);
    expect((await db.getAllNodeDescriptors()).map((r) => r.accountId)).toEqual(["5HEAD"]);
  });

  it("picks up new descriptors as the finalized head advances", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "10";
    client.minerRegistryDescriptorsByBlock.set("10", [
      makeDescriptor({ accountId: "5FIRST", blockNumber: "8" }),
    ]);
    // Once the loop is running, advance the head and grow the registry.
    setTimeout(() => {
      client.minerRegistryDescriptorsByBlock.set("20", [
        makeDescriptor({ accountId: "5FIRST", blockNumber: "8" }),
        makeDescriptor({ accountId: "5SECOND", blockNumber: "15" }),
      ]);
      state.observability.finalizedBlockHeight = "20";
    }, 40);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 160);
    await runDescriptorLoop(
      {
        config: makeConfig(),
        db,
        state,
        urls: ["ws://x"],
        clientFactory: () => client,
        scanIntervalMs: 15,
      },
      ac.signal,
    );

    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId).sort()).toEqual(["5FIRST", "5SECOND"]);
    expect(await db.getDescriptorCheckpoint()).toBe("20");
  });

  it("idles without writing until the finalized head is known", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = null;

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await runDescriptorLoop(
      { config: makeConfig(), db, state, urls: ["ws://x"], clientFactory: () => client },
      ac.signal,
    );

    expect(await db.getAllNodeDescriptors()).toHaveLength(0);
    expect(await db.getDescriptorCheckpoint()).toBeNull();
  });

  it("aborts promptly while idle", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = null;

    const ac = new AbortController();
    const loop = runDescriptorLoop(
      {
        config: makeConfig(),
        db,
        state,
        urls: ["ws://x"],
        clientFactory: () => client,
        scanIntervalMs: 60_000,
      },
      ac.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const abortedAt = Date.now();
    ac.abort();
    await loop;
    expect(Date.now() - abortedAt).toBeLessThan(500);
  });

  it("rotates to the next URL when a connect fails, then recovers", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "1";
    client.minerRegistryDescriptorsByBlock.set("1", [
      makeDescriptor({ blockNumber: "1", accountId: "5OK" }),
    ]);

    const seenUrls: string[] = [];
    let attempts = 0;
    const clientFactory = (url: string): FakeSubstrateClient => {
      seenUrls.push(url);
      attempts += 1;
      if (attempts === 1) {
        const failing = new FakeSubstrateClient();
        failing.connect = async () => {
          throw new Error("connect refused");
        };
        return failing;
      }
      return client;
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await runDescriptorLoop(
      { config: makeConfig(), db, state, urls: ["ws://a", "ws://b"], clientFactory },
      ac.signal,
    );

    expect(seenUrls.slice(0, 2)).toEqual(["ws://a", "ws://b"]);
    expect((await db.getAllNodeDescriptors()).map((r) => r.accountId)).toEqual(["5OK"]);
  });

  it("reconnects when a scan error coincides with a dead connection (no hot-loop)", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "1";
    client.minerRegistryDescriptorsByBlock.set("1", [
      makeDescriptor({ blockNumber: "1", accountId: "5OK" }),
    ]);

    const seenUrls: string[] = [];
    let attempts = 0;
    const clientFactory = (url: string): FakeSubstrateClient => {
      seenUrls.push(url);
      attempts += 1;
      if (attempts === 1) {
        // Socket died: connect() resolves but isConnected() is false, the scan
        // throws a transport error, and onDisconnected never fires. The worker
        // must rotate rather than hammer the dead client.
        const dead = new FakeSubstrateClient();
        dead.isConnected = () => false;
        dead.getMinerRegistryDescriptorsAt = async () => {
          throw new Error("WebSocket is not connected");
        };
        return dead;
      }
      return client;
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 250);
    await runDescriptorLoop(
      { config: makeConfig(), db, state, urls: ["ws://a", "ws://b"], clientFactory },
      ac.signal,
    );

    expect(seenUrls.slice(0, 2)).toEqual(["ws://a", "ws://b"]);
    expect((await db.getAllNodeDescriptors()).map((r) => r.accountId)).toEqual(["5OK"]);
  });

  it("keeps a healthy connection on a transient scan error and recovers next tick", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "1";

    const seenUrls: string[] = [];
    let scanCalls = 0;
    const clientFactory = (url: string): FakeSubstrateClient => {
      seenUrls.push(url);
      const c = new FakeSubstrateClient();
      c.minerRegistryDescriptorsByBlock.set("1", [
        makeDescriptor({ blockNumber: "1", accountId: "5OK" }),
      ]);
      const realScan = c.getMinerRegistryDescriptorsAt.bind(c);
      // First scan blips while the connection stays up; the worker must not
      // tear it down (no rotation) and must succeed on the next tick.
      c.getMinerRegistryDescriptorsAt = async (n: string) => {
        scanCalls += 1;
        if (scanCalls === 1) throw new Error("temporary RPC error");
        return realScan(n);
      };
      return c;
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 160);
    await runDescriptorLoop(
      {
        config: makeConfig(),
        db,
        state,
        urls: ["ws://a", "ws://b"],
        clientFactory,
        scanIntervalMs: 15,
      },
      ac.signal,
    );

    expect(seenUrls).toEqual(["ws://a"]); // never rotated
    expect((await db.getAllNodeDescriptors()).map((r) => r.accountId)).toEqual(["5OK"]);
  });
});
