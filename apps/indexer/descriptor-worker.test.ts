// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { NodeDescriptor } from "@quip/shared/telemetry";

import { runDescriptorIteration, runDescriptorLoop } from "./descriptor-worker";
import { IndexerState } from "./state";
import { FakeSubstrateClient, type MinerRegistryDescriptorRecord } from "./substrate-client";
import { makeConfig, newInMemoryAdapter } from "./test-helpers";

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

describe("runDescriptorIteration", () => {
  it("upserts a valid descriptor and advances the checkpoint", async () => {
    client.minerRegistryDescriptorsByBlock.set("100", [makeDescriptor()]);

    const advanced = await runDescriptorIteration({ db, client }, "100");
    expect(advanced).toBe(true);

    const all = await db.getAllNodeDescriptors();
    expect(all).toHaveLength(1);
    expect(all[0]?.accountId).toBe("5GPP");
    expect(all[0]?.descriptor.nodeName).toBe("rig-test");
    expect(all[0]?.firstBlockTimestamp).toBe(1_700_000_000);

    expect(await db.getDescriptorCheckpoint()).toBe("100");
  });

  it("upserts every descriptor in a registry snapshot", async () => {
    client.minerRegistryDescriptorsByBlock.set("200", [
      makeDescriptor({ accountId: "5AAA", blockNumber: "200", blockHash: "0xaaa" }),
      makeDescriptor({
        accountId: "5BBB",
        blockNumber: "200",
        blockHash: "0xbbb",
        descriptor: { ...VALID_DESCRIPTOR, nodeName: "rig-b" },
      }),
    ]);

    const advanced = await runDescriptorIteration({ db, client }, "200");
    expect(advanced).toBe(true);

    const all = await db.getAllNodeDescriptors();
    expect(all.map((r) => r.accountId).sort()).toEqual(["5AAA", "5BBB"]);
    expect(await db.getDescriptorCheckpoint()).toBe("200");
  });

  it("returns false when the block is not yet on chain", async () => {
    // The fake returns `null` when the key is explicitly set to null.
    client.minerRegistryDescriptorsByBlock.set("999", null);

    const advanced = await runDescriptorIteration({ db, client }, "999");
    expect(advanced).toBe(false);
    // Checkpoint stays at null so the loop retries this block.
    expect(await db.getDescriptorCheckpoint()).toBeNull();
  });

  it("preserves first_block_timestamp across upserts (newer block wins on data, older ts on first_seen)", async () => {
    // First descriptor at block 100, timestamp 1000.
    client.minerRegistryDescriptorsByBlock.set("100", [
      makeDescriptor({ blockNumber: "100", blockTimestamp: 1000, accountId: "5XYZ" }),
    ]);
    await runDescriptorIteration({ db, client }, "100");

    // Newer descriptor at block 200, timestamp 5000 — newer storage value, but
    // firstBlockTimestamp on the row should stay 1000.
    client.minerRegistryDescriptorsByBlock.set("200", [
      makeDescriptor({
        blockNumber: "200",
        blockTimestamp: 5000,
        accountId: "5XYZ",
        descriptor: { ...VALID_DESCRIPTOR, nodeName: "renamed" },
      }),
    ]);
    await runDescriptorIteration({ db, client }, "200");

    const rows = await db.getAllNodeDescriptors();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockTimestamp).toBe(5000);
    expect(rows[0]?.firstBlockTimestamp).toBe(1000);
    expect(rows[0]?.descriptor.nodeName).toBe("renamed");
  });
});

describe("runDescriptorLoop", () => {
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
      { config: makeConfig(), db, state, urls: ["ws://x"], clientFactory: () => client },
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
});
