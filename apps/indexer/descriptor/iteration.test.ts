// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { NodeDescriptor } from "@quip/shared/telemetry";

import {
  FakeSubstrateClient,
  type MinerRegistryDescriptorRecord,
} from "../clients/substrate-client";
import { newInMemoryAdapter } from "../core/test-helpers";
import { runDescriptorIteration } from "./iteration";

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
