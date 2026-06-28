// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  decodeBlockWinnerEventData,
  mapChainDescriptor,
  FakeSubstrateClient,
  PolkadotSubstrateClient,
  type BlockEvents,
  type SubstrateHead,
} from "./substrate-client";

describe("mapChainDescriptor", () => {
  // polkadot.js `.toJSON()` surfaces `Bytes` fields as 0x-prefixed hex.
  const hex = (s: string) =>
    "0x" +
    Array.from(new TextEncoder().encode(s))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  test("decodes a schema-v2 descriptor (hex bytes, enums, system_info)", () => {
    const raw = {
      schemaVersion: 2,
      nodeId: hex("node-1"),
      nodeName: hex("alice-rig"),
      publicHost: hex("alice.example.com"),
      publicPort: 20050,
      rpcEndpoints: [hex("https://rpc1"), hex("https://rpc2")],
      autoMine: true,
      logLevel: "Info",
      miners: [
        { kind: "Cpu", label: hex("cpu"), backend: null, deviceId: null },
        { kind: "QpuDwave", label: hex("dwave"), backend: null, deviceId: null },
        { kind: "Gpu", label: hex("gpu0"), backend: hex("cuda"), deviceId: hex("0") },
      ],
      runtime: {
        python: hex("3.13.13"),
        quipVersion: hex("0.2.1rc14"),
        protocolVersion: 2,
        inDocker: true,
        dockerImage: hex("registry/quip:abc1234"),
      },
      payloadHash: "0xdeadbeef",
      updatedAt: 1234,
      deposit: 1000000,
      systemInfo: {
        os: { system: hex("Linux"), release: hex("6.1.0"), machine: hex("x86_64") },
        cpu: {
          logicalCores: 16,
          physicalCores: 8,
          brand: hex("AMD EPYC 7763"),
          arch: hex("x86_64"),
        },
        memoryMb: 64000,
        gpus: [
          {
            index: 0,
            vendor: hex("NVIDIA"),
            name: hex("H100"),
            memoryMb: 81920,
            utilizationPct: 42,
          },
        ],
      },
    };

    expect(mapChainDescriptor("5Test", raw)).toEqual({
      accountId: "5Test",
      updatedAtBlock: "1234",
      payloadHash: "0xdeadbeef",
      descriptor: {
        schemaVersion: 2,
        nodeId: "node-1",
        nodeName: "alice-rig",
        publicHost: "alice.example.com",
        publicPort: 20050,
        rpcEndpoints: ["https://rpc1", "https://rpc2"],
        autoMine: true,
        logLevel: "Info",
        miners: [
          { kind: "CPU", label: "cpu" },
          { kind: "QPU", label: "dwave" },
          { kind: "GPU", label: "gpu0", backend: "cuda", deviceId: "0" },
        ],
        runtime: {
          python: "3.13.13",
          quipVersion: "0.2.1rc14",
          protocolVersion: 2,
          inDocker: true,
          dockerImage: "registry/quip:abc1234",
        },
        systemInfo: {
          os: { system: "Linux", release: "6.1.0", machine: "x86_64" },
          cpu: { logicalCores: 16, physicalCores: 8, brand: "AMD EPYC 7763", arch: "x86_64" },
          memoryMb: 64000,
          gpus: [{ index: 0, vendor: "NVIDIA", name: "H100", memoryMb: 81920, utilizationPct: 42 }],
        },
        deposit: "1000000",
      },
    });
  });

  test("decodes a schema-v1 descriptor (no system_info)", () => {
    const raw = {
      schemaVersion: 1,
      nodeId: hex("n2"),
      nodeName: hex("bob"),
      publicHost: null,
      publicPort: null,
      rpcEndpoints: [],
      autoMine: false,
      logLevel: "Debug",
      miners: [{ kind: "Asic", label: null, backend: null, deviceId: null }],
      payloadHash: "0xabc",
      updatedAt: 7,
      deposit: 0,
      systemInfo: null,
    };
    const out = mapChainDescriptor("5Bob", raw);
    expect(out.descriptor.schemaVersion).toBe(1);
    expect(out.descriptor.nodeName).toBe("bob");
    expect(out.descriptor.publicHost).toBeUndefined();
    expect(out.descriptor.systemInfo).toBeUndefined();
    expect(out.descriptor.miners).toEqual([{ kind: "OTHER" }]);
  });
});

describe("decodeBlockWinnerEventData", () => {
  const codec = (s: string) => ({ toString: () => s });

  test("decodes the v0.2 six-field BlockWinner event", () => {
    // quip-protocol-rs v0.2 order:
    // [qblock_id, block_number, miner, reward, energy_milli, submitted_at]
    const data = [
      codec("7"),
      codec("1234"),
      codec("5GrwMiner"),
      codec("1000"),
      codec("-2510"),
      codec("1230"),
    ];
    expect(decodeBlockWinnerEventData(data)).toEqual({
      qblockId: "7",
      blockNumber: "1234",
      miner: "5GrwMiner",
      reward: "1000",
      energyMilli: -2510,
      submittedAt: "1230",
    });
  });

  test("returns null when the event data is truncated", () => {
    expect(decodeBlockWinnerEventData([codec("7"), codec("1234")])).toBeNull();
  });
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
      qblockId: "1",
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
    expect(rt.specVersion).toBe(109);

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
        qblockId: "1",
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

describe("FakeSubstrateClient.getWinningSolution", () => {
  test("returns null when no solution is programmed for the block", async () => {
    const c = new FakeSubstrateClient();
    expect(await c.getWinningSolution("99")).toBeNull();
  });

  test("returns the programmed solution for a known block", async () => {
    const c = new FakeSubstrateClient();
    c.winningSolutionsByBlock.set("77", {
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
    const sol = await c.getWinningSolution("77");
    expect(sol?.nonce).toBe("12345");
    expect(sol?.difficulty.minSolutions).toBe(5);
  });
});
