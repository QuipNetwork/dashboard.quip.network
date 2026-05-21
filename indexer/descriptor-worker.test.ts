// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "../api/db/adapter";

import { runDescriptorIteration, runDescriptorLoop } from "./descriptor-worker";
import { IndexerState } from "./state";
import { FakeSubstrateClient, type RemarkRecord } from "./substrate-client";
import { makeConfig, newInMemoryAdapter } from "./test-helpers";

const VALID_BODY = JSON.stringify({
  schema: "quip.node_descriptor.v1",
  descriptor_version: 1,
  node_name: "rig-test",
  runtime: { quip_version: "0.2.0" },
});

function makeRemark(overrides: Partial<RemarkRecord> = {}): RemarkRecord {
  return {
    sender: "5GPP",
    body: VALID_BODY,
    blockNumber: "100",
    blockHash: "0xabc",
    blockTimestamp: 1_700_000_000,
    extrinsicIndex: 0,
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
    client.remarksByBlock.set("100", [makeRemark()]);

    const state = new IndexerState(db);
    const advanced = await runDescriptorIteration(
      { config: makeConfig(), db, client, state },
      "100",
    );
    expect(advanced).toBe(true);

    const all = await db.getAllNodeDescriptors();
    expect(all).toHaveLength(1);
    expect(all[0]?.accountId).toBe("5GPP");
    expect(all[0]?.descriptor.nodeName).toBe("rig-test");
    expect(all[0]?.firstBlockTimestamp).toBe(1_700_000_000);

    expect(await db.getDescriptorCheckpoint()).toBe("100");
  });

  it("drops invalid descriptors but still advances the checkpoint", async () => {
    // Two remarks in the same block: one valid, one with credential leak.
    const bad = JSON.stringify({
      schema: "quip.node_descriptor.v1",
      descriptor_version: 1,
      node_name: "leaky",
      log_level: "Bearer eyJalg-leaktoken-XYZabc1234567",
    });
    client.remarksByBlock.set("200", [
      makeRemark({ blockNumber: "200", extrinsicIndex: 0, sender: "5AAA" }),
      makeRemark({ blockNumber: "200", extrinsicIndex: 1, sender: "5BBB", body: bad }),
    ]);

    const state = new IndexerState(db);
    const advanced = await runDescriptorIteration(
      { config: makeConfig(), db, client, state },
      "200",
    );
    expect(advanced).toBe(true);

    const all = await db.getAllNodeDescriptors();
    // Only the clean descriptor lands; the credential-leak one is rejected.
    expect(all.map((r) => r.accountId)).toEqual(["5AAA"]);
    expect(await db.getDescriptorCheckpoint()).toBe("200");
  });

  it("returns false when the block is not yet on chain", async () => {
    // The fake returns `null` when the key is explicitly set to null.
    client.remarksByBlock.set("999", null);

    const state = new IndexerState(db);
    const advanced = await runDescriptorIteration(
      { config: makeConfig(), db, client, state },
      "999",
    );
    expect(advanced).toBe(false);
    // Checkpoint stays at null so the loop retries this block.
    expect(await db.getDescriptorCheckpoint()).toBeNull();
  });

  it("preserves first_block_timestamp across upserts (newer block wins on data, older ts on first_seen)", async () => {
    const state = new IndexerState(db);
    // First descriptor at block 100, timestamp 1000.
    client.remarksByBlock.set("100", [
      makeRemark({ blockNumber: "100", blockTimestamp: 1000, sender: "5XYZ" }),
    ]);
    await runDescriptorIteration({ config: makeConfig(), db, client, state }, "100");

    // Newer descriptor at block 200, timestamp 5000 — newer body, but
    // firstBlockTimestamp on the row should stay 1000.
    client.remarksByBlock.set("200", [
      makeRemark({
        blockNumber: "200",
        blockTimestamp: 5000,
        sender: "5XYZ",
        body: JSON.stringify({
          schema: "quip.node_descriptor.v1",
          descriptor_version: 1,
          node_name: "renamed",
        }),
      }),
    ]);
    await runDescriptorIteration({ config: makeConfig(), db, client, state }, "200");

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
    client.remarksByBlock.set("1", []);
    client.remarksByBlock.set("2", [makeRemark({ blockNumber: "2", sender: "5BLK2" })]);
    client.remarksByBlock.set("3", [makeRemark({ blockNumber: "3", sender: "5BLK3" })]);

    // Abort after 200ms — long enough to drain backfill + idle once.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    await runDescriptorLoop({ config: makeConfig(), db, client, state }, ac.signal);

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
    client.remarksByBlock.set("6", [makeRemark({ blockNumber: "6", sender: "5BLK6" })]);
    client.remarksByBlock.set("7", []);
    // Trap: putting remarks at block 3 — if the loop replayed, this would
    // sneak into the DB.
    client.remarksByBlock.set("3", [makeRemark({ blockNumber: "3", sender: "5OLD" })]);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    await runDescriptorLoop({ config: makeConfig(), db, client, state }, ac.signal);

    const rows = await db.getAllNodeDescriptors();
    expect(rows.map((r) => r.accountId)).toEqual(["5BLK6"]);
    expect(await db.getDescriptorCheckpoint()).toBe("7");
  });
});
