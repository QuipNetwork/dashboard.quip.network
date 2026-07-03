// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  FakeSubstrateClient,
  PolkadotSubstrateClient,
  decodeBlockWinnerEventData,
  decodeMinerRegistryDescriptor,
  type BlockEvents,
  type SubstrateHead,
} from ".";

// Minimal codec stand-in: polkadot.js event `data` entries expose `.toString()`.
const codec = (v: string | number): { toString: () => string } => ({
  toString: () => String(v),
});

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
      qblockId: "7",
      blockNumber: "42",
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

  test("subscribeBlockEvents groups events per block", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const seen: BlockEvents[] = [];
    await c.subscribeBlockEvents((e) => {
      seen.push(e);
    });
    c.emitBlock({
      blockNumber: 100,
      blockHash: "0xsub",
      parentHash: "0xsub99",
      author: "5Author",
      timestamp: 1700000000,
      winner: {
        qblockId: "3",
        blockNumber: "100",
        miner: "5GPPxx",
        reward: "1000",
        energyMilli: -2510,
        submittedAt: "100",
      },
      proofs: [
        {
          miner: "5GPPxx",
          energyMilli: -2510,
          diversityMilli: 420,
          validSolutionCount: 5,
        },
      ],
      nonce: "42",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.author).toBe("5Author");
    expect(seen[0]?.winner?.energyMilli).toBe(-2510);
    expect(seen[0]?.proofs).toHaveLength(1);
  });

  test("subscribeBlockEvents still fires when winner is null (authorship-only head)", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const seen: BlockEvents[] = [];
    await c.subscribeBlockEvents((e) => {
      seen.push(e);
    });
    // No PoW winner this block — author is still recorded.
    c.emitBlock({
      blockNumber: 101,
      blockHash: "0xnowin",
      parentHash: "0xsub",
      author: "5Author",
      timestamp: 1700000006,
      winner: null,
      proofs: [],
      nonce: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.winner).toBeNull();
    expect(seen[0]?.author).toBe("5Author");
  });

  test("getLastProofBlockAt returns programmed value", async () => {
    const c = new FakeSubstrateClient();
    c.lastProofBlockByHash.set("0xsub99", 94);
    expect(await c.getLastProofBlockAt("0xsub99")).toBe(94);
  });

  test("getTopology returns configured nodes/edges", async () => {
    const c = new FakeSubstrateClient();
    c.topology = { nodeCount: 100, edgeCount: 200 };
    expect(await c.getTopology()).toEqual({ nodeCount: 100, edgeCount: 200 });
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

// PolkadotSubstrateClient integration smoke test. Gated behind
// QUIP_TEST_VALIDATOR_RPC_URL so unit-test runs (and CI without a
// validator) don't depend on a live chain. Run locally against the
// nodes.quip.network v0.2 compose:
//   QUIP_TEST_VALIDATOR_RPC_URL=ws://localhost:9944 bun test
const integrationUrl = process.env.QUIP_TEST_VALIDATOR_RPC_URL;
const maybeTest = integrationUrl ? test : test.skip;

describe("PolkadotSubstrateClient (integration)", () => {
  maybeTest(
    "connects, reads runtime version, subscribes, disconnects",
    async () => {
      const client = new PolkadotSubstrateClient(integrationUrl!, 30_000);
      await client.connect();
      expect(client.isConnected()).toBe(true);

      const rt = await client.getRuntimeVersion();
      expect(rt.specName.length).toBeGreaterThan(0);

      // Quick subscription roundtrip — the chain produces ~1 block per 6s
      // on quip-protocol-rs spec 101, so wait up to 10s for one new head.
      const received: SubstrateHead[] = [];
      const unsub = await client.subscribeNewHeads((h) => received.push(h));
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      unsub();
      expect(received.length).toBeGreaterThan(0);

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    },
    30_000,
  );
});

describe("decodeBlockWinnerEventData (v0.2 6-field BlockWinner)", () => {
  test("decodes [qblock_id, block_number, miner, reward, energy_milli, submitted_at]", () => {
    const decoded = decodeBlockWinnerEventData([
      codec("7"),
      codec("4500"),
      codec("5GPPxx"),
      codec("1000000000000"),
      codec(-2510),
      codec("4498"),
    ]);
    expect(decoded).toEqual({
      qblockId: "7",
      blockNumber: "4500",
      miner: "5GPPxx",
      reward: "1000000000000",
      energyMilli: -2510,
      submittedAt: "4498",
    });
  });

  test("returns null when the data array is truncated", () => {
    expect(decodeBlockWinnerEventData([codec("7"), codec("4500"), codec("5GPPxx")])).toBeNull();
    expect(decodeBlockWinnerEventData([])).toBeNull();
  });
});

describe("decodeMinerRegistryDescriptor (V1 / V2 schema)", () => {
  // Bytes fields surface as 0x-prefixed hex via polkadot.js `.toJSON()`.
  const hex = (s: string) =>
    "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

  test("decodes a V1 descriptor (no runtime / systemInfo)", () => {
    const decoded = decodeMinerRegistryDescriptor({
      schemaVersion: 1,
      nodeName: hex("alpha"),
      updatedAt: 4500,
    });
    expect(decoded?.updatedAt).toBe("4500");
    expect(decoded?.descriptor.nodeName).toBe("alpha");
    expect(decoded?.descriptor.runtime).toBeUndefined();
    expect(decoded?.descriptor.systemInfo).toBeUndefined();
  });

  test("decodes a V2 descriptor with runtime + systemInfo (utilization → observedUtilizationPct)", () => {
    const decoded = decodeMinerRegistryDescriptor({
      schemaVersion: 2,
      nodeName: hex("beta"),
      updatedAt: 5000,
      runtime: {
        python: hex("3.12.1"),
        quipVersion: hex("0.2.0"),
        protocolVersion: 2,
        inDocker: true,
        dockerImage: hex("quip/miner:latest"),
      },
      systemInfo: {
        os: { system: hex("Linux"), release: hex("6.1"), machine: hex("x86_64") },
        cpu: { logicalCores: 16, physicalCores: 8, brand: hex("AMD"), arch: hex("x86_64") },
        memoryMb: 65536,
        gpus: [
          {
            index: 0,
            vendor: hex("NVIDIA"),
            name: hex("RTX"),
            memoryMb: 24576,
            utilizationPct: 73,
          },
        ],
      },
    });
    expect(decoded?.descriptor.nodeName).toBe("beta");
    expect(decoded?.descriptor.runtime).toEqual({
      python: "3.12.1",
      quipVersion: "0.2.0",
      protocolVersion: 2,
      inDocker: true,
      dockerImage: "quip/miner:latest",
    });
    expect(decoded?.descriptor.systemInfo?.os).toEqual({
      system: "Linux",
      release: "6.1",
      machine: "x86_64",
    });
    expect(decoded?.descriptor.systemInfo?.cpu?.logicalCores).toBe(16);
    expect(decoded?.descriptor.systemInfo?.memoryMb).toBe(65536);
    expect(decoded?.descriptor.systemInfo?.gpus?.[0]).toEqual({
      index: 0,
      vendor: "NVIDIA",
      name: "RTX",
      memoryMb: 24576,
      observedUtilizationPct: 73,
    });
  });

  test("rejects an unsupported schema_version", () => {
    expect(
      decodeMinerRegistryDescriptor({ schemaVersion: 3, nodeName: hex("x"), updatedAt: 1 }),
    ).toBeNull();
  });
});

describe("FakeSubstrateClient.getQBlock", () => {
  test("returns null when no solution is programmed for the block", async () => {
    const c = new FakeSubstrateClient();
    expect(await c.getQBlock("99")).toBeNull();
  });

  test("returns the programmed solution for a known block", async () => {
    const c = new FakeSubstrateClient();
    c.qblocksByBlock.set("77", {
      miner: "5GPPxx",
      energyMilli: -2510,
      reward: "1000",
      submittedAt: "77",
      nonce: "12345",
      difficulty: {
        maxEnergyMilli: -1200,
        minDiversityMilli: 200,
        minSolutions: 5,
      },
    });
    const sol = await c.getQBlock("77");
    expect(sol?.nonce).toBe("12345");
    expect(sol?.difficulty.minSolutions).toBe(5);
  });
});
