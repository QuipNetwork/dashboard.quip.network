// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { FakeSubstrateClient, type SubstrateHead } from "./substrate-client";

describe("FakeSubstrateClient", () => {
  test("emits finalized head to subscribers and stashes for getBlockHeader", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const received: SubstrateHead[] = [];
    const unsub = await c.subscribeFinalizedHeads((h) => {
      received.push(h);
    });
    const h: SubstrateHead = {
      number: "10",
      hash: "0xaa",
      parentHash: "0xa9",
      extrinsicsRoot: "0xee",
      stateRoot: "0xff",
    };
    c.emitFinalized(h);
    expect(received).toEqual([h]);
    // emitFinalized also stashes the header so a later getBlockHeader hits.
    const fetched = await c.getBlockHeader("10");
    expect(fetched).toEqual(h);
    unsub();
  });

  test("emits new head to subscribers", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const received: SubstrateHead[] = [];
    await c.subscribeNewHeads((h) => received.push(h));
    c.emitNew({
      number: "11",
      hash: "0xbb",
      parentHash: "0xaa",
      extrinsicsRoot: "0xee",
      stateRoot: "0xff",
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.number).toBe("11");
  });

  test("emits BlockWinner event with miner/energy/submittedAt", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const received: Array<{ miner: string; energyMilli: number; submittedAt: string }> = [];
    await c.subscribeBlockWinnerEvents((e) =>
      received.push({ miner: e.miner, energyMilli: e.energyMilli, submittedAt: e.submittedAt }),
    );
    c.emitBlockWinner({
      miner: "5Grw",
      reward: "1000",
      energyMilli: 12500,
      submittedAt: "42",
    });
    expect(received).toEqual([{ miner: "5Grw", energyMilli: 12500, submittedAt: "42" }]);
  });

  test("connect/disconnect flips isConnected and fires hooks", async () => {
    const c = new FakeSubstrateClient();
    const events: string[] = [];
    c.onConnected(() => events.push("connected"));
    c.onDisconnected(() => events.push("disconnected"));
    expect(c.isConnected()).toBe(false);
    await c.connect();
    expect(c.isConnected()).toBe(true);
    expect(events).toEqual(["connected"]);
    await c.disconnect();
    expect(c.isConnected()).toBe(false);
    expect(events).toEqual(["connected", "disconnected"]);
  });

  test("storage queries return defaults / programmable values", async () => {
    const c = new FakeSubstrateClient();
    expect(await c.getBabeEpoch()).toBeNull();
    expect(await c.getBabeAuthorities()).toEqual([]);
    expect(await c.getChainMiners()).toEqual([]);
    expect(await c.getDifficulty()).toBeNull();
    const rt = await c.getRuntimeVersion();
    expect(rt.specName).toBe("quip");
    expect(rt.specVersion).toBe(101);

    c.babeEpoch = {
      epochIndex: 1,
      currentSlot: "2400",
      epochStartSlot: "2400",
      slotsPerEpoch: 2400,
      authorityCount: 3,
    };
    const e = await c.getBabeEpoch();
    expect(e?.epochIndex).toBe(1);
  });

  test("getBlockHeader returns null for unknown block numbers", async () => {
    const c = new FakeSubstrateClient();
    expect(await c.getBlockHeader("missing")).toBeNull();
  });

  test("unsubscribe removes the callback", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    let count = 0;
    const unsub = await c.subscribeFinalizedHeads(() => count++);
    c.emitFinalized({
      number: "1",
      hash: "0xa",
      parentHash: "0x0",
      extrinsicsRoot: "0xe",
      stateRoot: "0xs",
    });
    unsub();
    c.emitFinalized({
      number: "2",
      hash: "0xb",
      parentHash: "0xa",
      extrinsicsRoot: "0xe",
      stateRoot: "0xs",
    });
    expect(count).toBe(1);
  });
});
