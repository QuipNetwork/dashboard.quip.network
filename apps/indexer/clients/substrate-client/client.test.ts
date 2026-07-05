// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { TypeRegistry } from "@polkadot/types";

import {
  FakeSubstrateClient,
  HYBRID_EXTRINSIC_TYPES,
  PolkadotSubstrateClient,
  decodeBlockWinnerEventData,
  decodeMinerRegistryDescriptor,
  qblockInfoFromSolution,
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

describe("HYBRID_EXTRINSIC_TYPES (per-block registry overrides)", () => {
  // polkadot.js swaps to a FRESH registry for blocks from older runtime
  // specVersions (@polkadot/api base/Init.js: setRegistrySwap →
  // _createBlockRegistry → _initRegistry). _initRegistry seeds that registry
  // ONLY from the ApiPromise.create options: setKnownTypes(options) then
  // register(getSpecTypes(...)), where getSpecTypes merges knownTypes.types
  // as the final catch-all override. For a chain with no built-in known
  // types that reduces to exactly the user-supplied map — which is what we
  // reproduce here. A post-create api.registry.register() call never reaches
  // these registries (the original bug: backfilled pre-upgrade blocks failed
  // with "Signed Extrinsics are currently only available for ExtrinsicV4").
  const perBlockRegistry = (): TypeRegistry => {
    const registry = new TypeRegistry();
    registry.setKnownTypes({ types: HYBRID_EXTRINSIC_TYPES });
    registry.register({ ...(registry.knownTypes.types ?? {}) });
    return registry;
  };

  const createSignature = (
    registry: TypeRegistry,
    version: "ExtrinsicSignatureV4" | "ExtrinsicSignatureV5",
    opts: { isSigned?: boolean },
  ): { isSigned: boolean } =>
    registry.createTypeUnsafe(version, [undefined, opts]) as unknown as { isSigned: boolean };

  test.each(["ExtrinsicSignatureV4", "ExtrinsicSignatureV5"] as const)(
    "%s trusts the preamble-derived isSigned option on a fresh registry",
    (version) => {
      const registry = perBlockRegistry();
      // The stock GenericExtrinsicSignature derives isSigned from the
      // signature bytes' emptiness, which is wrong for quip's concrete
      // HybridTxSignature struct. The hybrid override must track the
      // constructor option in BOTH directions.
      expect(createSignature(registry, version, { isSigned: true }).isSigned).toBe(true);
      expect(createSignature(registry, version, {}).isSigned).toBe(false);
    },
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

describe("qblockInfoFromSolution (spec-111 device_access_time_us)", () => {
  const base = {
    miner: "5GWinner",
    energyMilli: -14_500_123,
    reward: "1000000000000",
    submittedAt: "500000",
    difficulty: { maxEnergyMilli: -14_400_000, minDiversityMilli: 100, minSolutions: 2 },
  };

  test("reads the camelCase number that polkadot-js toJSON emits for small u64", () => {
    const info = qblockInfoFromSolution({ ...base, deviceAccessTimeUs: 45_000_000 }, "123");
    expect(info.deviceAccessTimeUs).toBe(45_000_000);
    expect(info.nonce).toBe("123");
  });

  test("deviceAccessTimeUs: 0 maps to 0, not null (present-but-unreported)", () => {
    const info = qblockInfoFromSolution({ ...base, deviceAccessTimeUs: 0 }, "123");
    expect(info.deviceAccessTimeUs).toBe(0);
  });

  test("hex-string input parses correctly (polkadot-js emits 0x… for u64 > 2^52)", () => {
    // Number("0x2a") === 42; Number.isFinite(42) → true; no null coercion.
    const info = qblockInfoFromSolution({ ...base, deviceAccessTimeUs: "0x2a" }, "123");
    expect(info.deviceAccessTimeUs).toBe(42);
  });

  test("reads the snake_case spelling defensively", () => {
    const info = qblockInfoFromSolution({ ...base, device_access_time_us: 7 }, "123");
    expect(info.deviceAccessTimeUs).toBe(7);
  });

  test("absent field (pre-111 chain) maps to null, not 0", () => {
    const info = qblockInfoFromSolution(base, "123");
    expect(info.deviceAccessTimeUs).toBeNull();
  });

  test("non-numeric garbage maps to null", () => {
    const info = qblockInfoFromSolution({ ...base, deviceAccessTimeUs: "bogus" }, "123");
    expect(info.deviceAccessTimeUs).toBeNull();
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

describe("PolkadotSubstrateClient topology-by-hash cache", () => {
  // Inject a fake `api` so the topology read paths run without a live chain.
  // The cache is a private field; we exercise it purely through the public
  // methods and count how often the underlying runtime/storage reads fire.
  const optHash = (hex: string) => ({ isSome: true, unwrap: () => ({ toHex: () => hex }) });
  const meta = (nodes: number, edges: number) => ({
    isSome: true,
    unwrap: () => ({ nodes: { length: nodes }, edges: { length: edges } }),
  });
  // topologyMeta additionally exposes the allowed H/J value specs used to
  // derive the (static) curve constant.
  const mineableMeta = (nodes: number, edges: number) => ({
    isSome: true,
    unwrap: () => ({
      nodes: { length: nodes },
      edges: { length: edges },
      allowedHValues: { toJSON: () => ({ set: [-1000, 1000] }) },
      allowedJValues: { toJSON: () => ({ set: [-1000, 1000] }) },
    }),
  });

  const withApi = (api: unknown): PolkadotSubstrateClient => {
    const client = new PolkadotSubstrateClient("ws://unused");
    (client as unknown as { api: unknown }).api = api;
    return client;
  };

  test("getTopology resolves a hash once, then serves node/edge counts from cache", async () => {
    let registeredCalls = 0;
    const client = withApi({
      query: {
        quantumPow: {
          defaultTopology: () => Promise.resolve(optHash("0xabc")),
          registeredTopologies: (_hash: string) => {
            registeredCalls++;
            return Promise.resolve(meta(120, 300));
          },
        },
      },
    });
    const first = await client.getTopology();
    const second = await client.getTopology();
    expect(registeredCalls).toBe(1);
    expect(first).toEqual({ nodeCount: 120, edgeCount: 300 });
    expect(second).toEqual(first);
  });

  test("disconnect clears the cache so the next resolve hits the chain again", async () => {
    let registeredCalls = 0;
    const makeApi = () => ({
      query: {
        quantumPow: {
          defaultTopology: () => Promise.resolve(optHash("0xabc")),
          registeredTopologies: (_hash: string) => {
            registeredCalls++;
            return Promise.resolve(meta(120, 300));
          },
        },
      },
      disconnect: () => Promise.resolve(),
    });
    const client = withApi(makeApi());
    await client.getTopology();
    expect(registeredCalls).toBe(1);
    await client.disconnect();
    // Re-attach a fresh api (new connection); the cache must not survive.
    (client as unknown as { api: unknown }).api = makeApi();
    await client.getTopology();
    expect(registeredCalls).toBe(2);
  });

  test("getMineableTopologies caches node/edge counts but re-reads decayed difficulty", async () => {
    let metaCalls = 0;
    let diffCalls = 0;
    const client = withApi({
      query: {
        quantumPow: {
          defaultTopology: () => Promise.resolve(optHash("0xabc")),
        },
      },
      call: {
        quantumPowApi: {
          mineableTopologies: () => Promise.resolve({ toJSON: () => ["0xabc"] }),
          difficultyFor: (_hash: string) => {
            diffCalls++;
            return Promise.resolve({
              isSome: true,
              unwrap: () => ({
                toJSON: () => ({ maxEnergyMilli: -100, minDiversityMilli: 5, minSolutions: 1 }),
              }),
            });
          },
          topologyMeta: (_hash: string) => {
            metaCalls++;
            return Promise.resolve(mineableMeta(120, 300));
          },
        },
      },
    });
    const first = await client.getMineableTopologies();
    const second = await client.getMineableTopologies();
    // Static node/edge/curve metadata resolved once; decayed difficulty each time.
    expect(metaCalls).toBe(1);
    expect(diffCalls).toBe(2);
    expect(first[0]?.nodeCount).toBe(120);
    expect(first[0]?.edgeCount).toBe(300);
    expect(second[0]?.nodeCount).toBe(120);
    expect(second[0]?.curveConstant).toBe(first[0]?.curveConstant);
  });

  test("getTopology and getMineableTopologies share the same per-hash cache", async () => {
    let metaCalls = 0;
    let registeredCalls = 0;
    const client = withApi({
      query: {
        quantumPow: {
          defaultTopology: () => Promise.resolve(optHash("0xabc")),
          registeredTopologies: (_hash: string) => {
            registeredCalls++;
            return Promise.resolve(meta(120, 300));
          },
        },
      },
      call: {
        quantumPowApi: {
          mineableTopologies: () => Promise.resolve({ toJSON: () => ["0xabc"] }),
          difficultyFor: (_hash: string) =>
            Promise.resolve({
              isSome: true,
              unwrap: () => ({
                toJSON: () => ({ maxEnergyMilli: -100, minDiversityMilli: 5, minSolutions: 1 }),
              }),
            }),
          topologyMeta: (_hash: string) => {
            metaCalls++;
            return Promise.resolve(mineableMeta(120, 300));
          },
        },
      },
    });
    // getMineableTopologies resolves the curve constant via topologyMeta and
    // seeds the cache; getTopology then serves node/edge counts with no read.
    await client.getMineableTopologies();
    const topo = await client.getTopology();
    expect(metaCalls).toBe(1);
    expect(registeredCalls).toBe(0);
    expect(topo).toEqual({ nodeCount: 120, edgeCount: 300 });
  });
});

describe("PolkadotSubstrateClient.decodeWinnerBlock (targeted decode)", () => {
  const eventRec = (section: string, method: string, data: Array<{ toString: () => string }>) => ({
    event: { section, method, data },
  });

  // A representative winner block: one BlockWinner + two ProofAccepted events
  // (plus unrelated noise that must be filtered out).
  const winnerData = [
    codec("7"),
    codec("4500"),
    codec("5GPPxx"),
    codec("1000000000000"),
    codec(-2510),
    codec("4498"),
  ];
  const winnerEvents = [
    eventRec("system", "ExtrinsicSuccess", []),
    eventRec("quantumPow", "BlockWinner", winnerData),
    eventRec("quantumPow", "ProofAccepted", [codec("5GPPxx"), codec(-2510), codec(420), codec(5)]),
    eventRec("quantumPow", "ProofAccepted", [codec("5Other"), codec(-1000), codec(300), codec(3)]),
  ];
  const noWinnerEvents = [
    eventRec("system", "ExtrinsicSuccess", []),
    eventRec("quantumPow", "ProofAccepted", [codec("5GPPxx"), codec(-2510), codec(420), codec(5)]),
  ];

  const solutionOpt = {
    isSome: true,
    unwrap: () => ({
      solution: {
        toJSON: () => ({
          miner: "5GPPxx",
          energyMilli: -2510,
          reward: "1000000000000",
          submittedAt: "4498",
          difficulty: { maxEnergyMilli: -1200, minDiversityMilli: 200, minSolutions: 5 },
          deviceAccessTimeUs: 12,
        }),
      },
      nonce: codec("999888777"),
    }),
  };

  // Fake api covering both decode paths. `deriveThrows` makes
  // derive.chain.getBlock explode (the winner path must never touch it);
  // otherwise it returns author + events so the full-decode golden succeeds
  // and increments the shared counter.
  const makeApi = (opts: {
    events?: unknown;
    solution?: unknown;
    deriveThrows?: boolean;
    deriveCalls?: { n: number };
    eventsThrows?: unknown;
  }) => {
    const events = opts.events ?? winnerEvents;
    const solution = "solution" in opts ? opts.solution : solutionOpt;
    return {
      rpc: {
        chain: {
          getBlockHash: (_n: string) => Promise.resolve({ toHex: () => "0xhash4500" }),
          getHeader: (_h: unknown) =>
            Promise.resolve({ parentHash: { toHex: () => "0xhash4499" } }),
        },
      },
      query: {
        system: {
          events: {
            at: (_h: string) => {
              if (opts.eventsThrows) return Promise.reject(opts.eventsThrows);
              return Promise.resolve(events);
            },
          },
        },
        timestamp: { now: { at: (_h: string) => Promise.resolve(codec("1700000000000")) } },
      },
      call: {
        quantumPowApi: { winningSolution: (_n: string) => Promise.resolve(solution) },
      },
      derive: {
        chain: {
          getBlock: (_h: string) => {
            if (opts.deriveCalls) opts.deriveCalls.n++;
            if (opts.deriveThrows) {
              return Promise.reject(new Error("derive.chain.getBlock must not be called"));
            }
            return Promise.resolve({
              author: { toString: () => "0xAUTHOR" },
              events,
            });
          },
        },
      },
    };
  };

  const withApi = (api: unknown): PolkadotSubstrateClient => {
    const client = new PolkadotSubstrateClient("ws://unused");
    (client as unknown as { api: unknown }).api = api;
    return client;
  };

  test("winner/proofs/nonce equal the full decode, with zero derive.chain.getBlock", async () => {
    // Golden: the existing full-block path (which DOES fetch the block).
    const goldenCalls = { n: 0 };
    const goldenClient = withApi(makeApi({ deriveCalls: goldenCalls }));
    const golden = await (
      goldenClient as unknown as {
        decodeFinalizedBlock: (h: string, p: string, n: number) => Promise<BlockEvents | null>;
      }
    ).decodeFinalizedBlock("0xhash4500", "0xhash4499", 4500);
    expect(goldenCalls.n).toBe(1);

    // Targeted: same fixture, but derive.chain.getBlock is wired to throw —
    // the winner path must produce the equivalent result without it.
    const winnerCalls = { n: 0 };
    const winnerClient = withApi(makeApi({ deriveThrows: true, deriveCalls: winnerCalls }));
    const targeted = await winnerClient.decodeWinnerBlock("4500");
    expect(winnerCalls.n).toBe(0);

    expect(targeted?.events.winner).toEqual(golden?.winner ?? null);
    expect(targeted?.events.proofs).toEqual(golden?.proofs ?? []);
    expect(targeted?.events.nonce).toBe(golden?.nonce ?? null);
    // diversity + validSolutionCount are event-only; recovered from events.at.
    expect(targeted?.events.proofs[0]?.diversityMilli).toBe(420);
    expect(targeted?.events.proofs[0]?.validSolutionCount).toBe(5);
    // Winner-only path leaves author null (authorship backfills at the tip).
    expect(targeted?.events.author).toBeNull();
    expect(targeted?.events.timestamp).toBe(1700000000);
    // The single winning_solution fetch is returned for the dispatcher to reuse.
    expect(targeted?.qblock?.nonce).toBe("999888777");
  });

  test("returns null for a block with no BlockWinner event", async () => {
    const client = withApi(makeApi({ events: noWinnerEvents }));
    expect(await client.decodeWinnerBlock("4500")).toBeNull();
  });

  test("nonce is null when the winning_solution runtime value is unavailable", async () => {
    const client = withApi(makeApi({ solution: { isSome: false } }));
    const res = await client.decodeWinnerBlock("4500");
    expect(res?.events.winner).not.toBeNull();
    expect(res?.events.nonce).toBeNull();
    expect(res?.qblock).toBeNull();
  });

  test("propagates StatePrunedError from pruned historical state", async () => {
    const client = withApi(
      makeApi({ eventsThrows: new Error("state already discarded for 0xhash4500") }),
    );
    await expect(client.decodeWinnerBlock("4500")).rejects.toThrow(/state already discarded/i);
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
      deviceAccessTimeUs: null,
      topologyHash: null,
    });
    const sol = await c.getQBlock("77");
    expect(sol?.nonce).toBe("12345");
    expect(sol?.difficulty.minSolutions).toBe(5);
  });
});
