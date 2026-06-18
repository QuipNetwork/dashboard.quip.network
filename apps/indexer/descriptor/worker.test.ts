// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { NodeDescriptor } from "@quip/shared/telemetry";

import { IndexerState } from "../core/state";
import { FakeSubstrateClient, type MinerRegistryDescriptorRecord } from "../clients/substrate-client";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";
import { DescriptorWorker, type DescriptorWorkerDeps } from "./worker";

// Wrap construction so the behaviour tests below read as one call. Tiny poll /
// backoff windows keep the reconnect + idle paths fast under test.
const runDescriptorLoop = (deps: DescriptorWorkerDeps, signal: AbortSignal): Promise<void> =>
  new DescriptorWorker({ idlePollMs: 10, errorBackoffMs: 10, ...deps }).run(signal);

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

describe("DescriptorWorker loop", () => {
  it("backfills from start block to finalized head, then idles", async () => {
    const state = new IndexerState(db);
    // Simulate a finalized chain head at block 3.
    state.observability.finalizedBlockHeight = "3";
    client.minerRegistryDescriptorsByBlock.set("1", []);
    client.minerRegistryDescriptorsByBlock.set("2", [
      makeDescriptor({ blockNumber: "2", accountId: "5BLK2" }),
    ]);
    client.minerRegistryDescriptorsByBlock.set("3", [
      makeDescriptor({ blockNumber: "3", accountId: "5BLK3" }),
    ]);

    // Abort after 200ms — long enough to drain backfill + idle once.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    await runDescriptorLoop(
      {
        config: makeConfig(),
        db,
        state,
        urls: ["ws://x"],
        clientFactory: () => client,
      },
      ac.signal,
    );

    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId).sort()).toEqual(["5BLK2", "5BLK3"]);
    expect(await db.getDescriptorCheckpoint()).toBe("3");
  });

  it("resumes from the persisted checkpoint on restart", async () => {
    await db.setDescriptorCheckpoint("5");

    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "7";
    // Blocks 1..5 were "already" processed before this run; the loop must
    // not re-process them. Block 6 and 7 are fresh.
    client.minerRegistryDescriptorsByBlock.set("6", [
      makeDescriptor({ blockNumber: "6", accountId: "5BLK6" }),
    ]);
    client.minerRegistryDescriptorsByBlock.set("7", []);
    // Trap: putting a descriptor at block 3 — if the loop replayed, this would
    // sneak into the DB.
    client.minerRegistryDescriptorsByBlock.set("3", [
      makeDescriptor({ blockNumber: "3", accountId: "5OLD" }),
    ]);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    await runDescriptorLoop(
      {
        config: makeConfig(),
        db,
        state,
        urls: ["ws://x"],
        clientFactory: () => client,
      },
      ac.signal,
    );

    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId)).toEqual(["5BLK6"]);
    expect(await db.getDescriptorCheckpoint()).toBe("7");
  });

  // --- Lifecycle invariants (Worker-migration safety net) ---
  // The loop must unwind promptly from an idle wait on abort, and must treat
  // a pruned-state RPC error as a permanent miss that advances the checkpoint
  // rather than hot-looping the block. These must hold identically after the
  // loop is reshaped into a DescriptorWorker class.

  it("aborts promptly while idle (caught up to the finalized head)", async () => {
    const state = new IndexerState(db);
    // nextBlock starts at 1 (genesis); a finalized head of 0 means the loop is
    // immediately caught up and parks in the idle poll.
    state.observability.finalizedBlockHeight = "0";

    const ac = new AbortController();
    const loop = runDescriptorLoop(
      // A long idle window so the loop genuinely parks; abort must unwind it.
      { config: makeConfig(), db, state, urls: ["ws://x"], clientFactory: () => client, idlePollMs: 60_000 },
      ac.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const abortedAt = Date.now();
    ac.abort();
    await loop;
    expect(Date.now() - abortedAt).toBeLessThan(500);
  });

  it("skips a pruned-state block and advances the checkpoint past it", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "2";
    // Block 1's state has been discarded by the pruned validator; block 2 is
    // a normal empty snapshot. The loop must skip 1 (advancing the checkpoint)
    // and still process 2 rather than retrying 1 forever.
    client.getMinerRegistryDescriptorsAt = async (blockNumber: string) => {
      if (blockNumber === "1") throw new Error("State already discarded");
      return [];
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await runDescriptorLoop(
      { config: makeConfig(), db, state, urls: ["ws://x"], clientFactory: () => client },
      ac.signal,
    );

    expect(await db.getDescriptorCheckpoint()).toBe("2");
    expect(await db.getAllNodeDescriptors()).toHaveLength(0);
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
      // First endpoint refuses the connection; the loop must rotate to the
      // second and drain there.
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
    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId)).toEqual(["5OK"]);
    expect(await db.getDescriptorCheckpoint()).toBe("1");
  });

  it("reconnects when a scan error coincides with a dead connection (no hot-loop)", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "1";
    client.minerRegistryDescriptorsByBlock.set("1", [
      makeDescriptor({ blockNumber: "1", accountId: "5OK" }),
    ]);

    // First client's socket has died: connect() resolves but isConnected() is
    // false, the per-block RPC throws a (non-pruned) transport error, and the
    // onDisconnected event never fires. The worker must NOT retry the dead
    // client forever — it must rotate to the healthy endpoint.
    const seenUrls: string[] = [];
    let attempts = 0;
    const clientFactory = (url: string): FakeSubstrateClient => {
      seenUrls.push(url);
      attempts += 1;
      if (attempts === 1) {
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
    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId)).toEqual(["5OK"]);
    expect(await db.getDescriptorCheckpoint()).toBe("1");
  });

  it("resumes from the checkpoint after a mid-run drop (reconnect, no replay)", async () => {
    const state = new IndexerState(db);
    state.observability.finalizedBlockHeight = "1";

    const client1 = new FakeSubstrateClient();
    client1.minerRegistryDescriptorsByBlock.set("1", [
      makeDescriptor({ blockNumber: "1", accountId: "5BLK1" }),
    ]);
    const client2 = new FakeSubstrateClient();
    // Trap: if the worker replayed block 1 after reconnecting (instead of
    // resuming at checkpoint+1), 5TRAP would sneak into the DB.
    client2.minerRegistryDescriptorsByBlock.set("1", [
      makeDescriptor({ blockNumber: "1", accountId: "5TRAP" }),
    ]);
    client2.minerRegistryDescriptorsByBlock.set("2", [
      makeDescriptor({ blockNumber: "2", accountId: "5BLK2" }),
    ]);

    const seenUrls: string[] = [];
    let attempts = 0;
    const clientFactory = (url: string): FakeSubstrateClient => {
      seenUrls.push(url);
      return ++attempts === 1 ? client1 : client2;
    };

    // Once block 1 is drained and the worker is idling, drop client1 and reveal
    // block 2 on chain. The reconnect must resume at checkpoint+1 (block 2),
    // never replaying block 1 on the fresh client.
    setTimeout(() => {
      state.observability.finalizedBlockHeight = "2";
      void client1.disconnect();
    }, 80);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 250);
    await runDescriptorLoop(
      { config: makeConfig(), db, state, urls: ["ws://a", "ws://b"], clientFactory },
      ac.signal,
    );

    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId).sort()).toEqual(["5BLK1", "5BLK2"]);
    expect(seenUrls.slice(0, 2)).toEqual(["ws://a", "ws://b"]);
    expect(await db.getDescriptorCheckpoint()).toBe("2");
  });
});
