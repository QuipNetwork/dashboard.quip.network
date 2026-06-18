// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { NodeDescriptor } from "@quip/shared/telemetry";

import { newInMemoryAdapter } from "../core/test-helpers";
import { reconstructFirstSeen, type FirstSeenSource } from "./reconstruct";

const DESC: NodeDescriptor = {
  schema: "quip.node_descriptor.v1",
  descriptorVersion: 1,
  nodeName: "rig",
};

// Block timestamp mapping the fake chain uses (deterministic, arbitrary).
const tsOf = (block: number): number => block * 6;

// Fake chain where each account first appears at a fixed block and presence is
// monotonic thereafter (the documented assumption). Counts presence reads so a
// test can assert the search is logarithmic, not linear, in head height.
function fakeSource(
  firstAppearance: Record<string, number>,
  head: number,
): FirstSeenSource & { reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    async getFinalizedHead() {
      return String(head);
    },
    async isDescriptorPresentAt(accountId, blockNumber) {
      reads += 1;
      const first = firstAppearance[accountId];
      return first !== undefined && Number(blockNumber) >= first;
    },
    async getBlockTimestamp(blockNumber) {
      return tsOf(Number(blockNumber));
    },
  };
}

let db: DatabaseAdapter;

beforeEach(async () => {
  db = await newInMemoryAdapter();
});
afterEach(async () => {
  await db.disconnect();
});

// Seed a descriptor row, optionally with a deliberately-wrong firstSeen (what a
// head-snapshot rebuild would leave: the latest updated_at, not the first).
async function seed(
  accountId: string,
  opts: { updatedAtBlock: number; firstSeenTs: number },
): Promise<void> {
  await db.upsertNodeDescriptor({
    accountId,
    blockNumber: String(opts.updatedAtBlock),
    blockHash: `0x${accountId}`,
    extrinsicIndex: 0,
    blockTimestamp: opts.firstSeenTs,
    firstBlockTimestamp: opts.firstSeenTs,
    descriptor: DESC,
    observedAt: "2026-01-01T00:00:00.000Z",
  });
}

const firstSeenOf = async (accountId: string): Promise<number | undefined> =>
  (await db.getNodeDescriptor(accountId))?.firstBlockTimestamp;

describe("reconstructFirstSeen", () => {
  it("lowers firstSeen to the true first-appearance block timestamp", async () => {
    // Seeded with the head-snapshot's wrong value: latest update at block 200.
    await seed("5MID", { updatedAtBlock: 200, firstSeenTs: tsOf(200) });
    await seed("5GENESIS", { updatedAtBlock: 480, firstSeenTs: tsOf(480) });

    const source = fakeSource({ "5MID": 100, "5GENESIS": 1 }, 500);
    const summary = await reconstructFirstSeen({ source, store: db });

    expect(await firstSeenOf("5MID")).toBe(tsOf(100));
    expect(await firstSeenOf("5GENESIS")).toBe(tsOf(1));
    expect(summary.accountsProcessed).toBe(2);
    expect(summary.accountsSkipped).toBe(0);
  });

  it("finds the boundary exactly (account first appears at the head block)", async () => {
    await seed("5LATE", { updatedAtBlock: 500, firstSeenTs: tsOf(500) });
    const source = fakeSource({ "5LATE": 500 }, 500);
    await reconstructFirstSeen({ source, store: db });
    expect(await firstSeenOf("5LATE")).toBe(tsOf(500));
  });

  it("uses O(accounts × log(head)) reads, not O(accounts × head)", async () => {
    const head = 100_000;
    const accounts = ["5A", "5B", "5C", "5D", "5E"];
    // Seed every row with the head timestamp — the worst case a head snapshot
    // leaves — so the true first appearance is always earlier and gets lowered.
    for (const a of accounts) {
      await seed(a, { updatedAtBlock: head, firstSeenTs: tsOf(head) });
    }
    const source = fakeSource(
      { "5A": 1, "5B": 12_345, "5C": 50_000, "5D": 99_999, "5E": 100_000 },
      head,
    );
    const summary = await reconstructFirstSeen({ source, store: db });

    const linear = accounts.length * head;
    console.log(
      `[stress] firstSeen reconstruction over head=${head}, ${accounts.length} accounts: ` +
        `${summary.presenceReads} presence reads vs ${linear} for a per-block walk ` +
        `(${(linear / summary.presenceReads).toFixed(0)}x fewer)`,
    );
    // ~log2(100000) ≈ 17 per account, plus one head-presence check.
    expect(summary.presenceReads).toBeLessThan(accounts.length * 20);
    expect(await firstSeenOf("5A")).toBe(tsOf(1));
    expect(await firstSeenOf("5C")).toBe(tsOf(50_000));
    expect(await firstSeenOf("5E")).toBe(tsOf(100_000));
  });

  it("never raises an already-earlier firstSeen (LEAST guard)", async () => {
    // Existing firstSeen is earlier than the true first appearance the search
    // would compute; reconstruction must not move it later.
    await seed("5EARLY", { updatedAtBlock: 300, firstSeenTs: tsOf(10) });
    const source = fakeSource({ "5EARLY": 100 }, 500);
    await reconstructFirstSeen({ source, store: db });
    expect(await firstSeenOf("5EARLY")).toBe(tsOf(10));
  });

  it("skips rows whose descriptor is absent at the head (stale / deregistered)", async () => {
    await seed("5GONE", { updatedAtBlock: 200, firstSeenTs: tsOf(200) });
    // firstAppearance has no entry → never present.
    const source = fakeSource({}, 500);
    const summary = await reconstructFirstSeen({ source, store: db });

    expect(await firstSeenOf("5GONE")).toBe(tsOf(200)); // untouched
    expect(summary.accountsProcessed).toBe(0);
    expect(summary.accountsSkipped).toBe(1);
  });
});
