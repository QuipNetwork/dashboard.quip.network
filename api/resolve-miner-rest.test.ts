// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { newInMemoryAdapter } from "../indexer/test-helpers";
import type { NodeDescriptor } from "../src/types/telemetry";

import { discoverLocalOperator, resolveSelfMinerRestUrl } from "./resolve-miner-rest";

function descriptor(overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    schema: "quip.node_descriptor.v1",
    descriptorVersion: 1,
    nodeName: "test-rig",
    publicHost: undefined,
    publicPort: undefined,
    rpcEndpoints: undefined,
    autoMine: undefined,
    logLevel: undefined,
    runtime: undefined,
    miners: undefined,
    systemInfo: undefined,
    ...overrides,
  };
}

async function seedDescriptor(
  db: Awaited<ReturnType<typeof newInMemoryAdapter>>,
  accountId: string,
  desc: NodeDescriptor,
  blockNumber: string = "100",
): Promise<void> {
  await db.upsertNodeDescriptor({
    accountId,
    blockNumber,
    blockHash: "0xdead",
    extrinsicIndex: 1,
    blockTimestamp: 1_700_000_000,
    firstBlockTimestamp: 1_700_000_000,
    descriptor: desc,
    observedAt: new Date(1_700_000_000_000).toISOString(),
  });
}

function fakeFetch(map: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input, _init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const hit = map[url];
    if (!hit) {
      // Default: simulate a "wrong service" (405 from substrate RPC).
      return new Response("method not allowed", { status: 405 });
    }
    return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("discoverLocalOperator", () => {
  test("returns null when no descriptors are stored", async () => {
    const db = await newInMemoryAdapter();
    const result = await discoverLocalOperator(db, { fetchImpl: fakeFetch({}) });
    expect(result).toBeNull();
  });

  test("returns null when descriptors lack publicHost", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(db, "5HYNoHost", descriptor({ publicHost: undefined }));
    const result = await discoverLocalOperator(db, { fetchImpl: fakeFetch({}) });
    expect(result).toBeNull();
  });

  test("returns accountId when status.ss58_address matches descriptor.accountId", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(
      db,
      "5HY4e5KJiAu5xhjqQn1bhymmDEvz8EfivCETPW7PkJso7qBe",
      descriptor({ publicHost: "qpu-1.nodes.quip.network" }),
    );
    const fetchImpl = fakeFetch({
      "https://qpu-1.nodes.quip.network/api/v1/status": {
        status: 200,
        body: { success: true, data: { ss58_address: "5HY4e5KJiAu5xhjqQn1bhymmDEvz8EfivCETPW7PkJso7qBe" } },
      },
    });
    const result = await discoverLocalOperator(db, { fetchImpl });
    expect(result).toBe("5HY4e5KJiAu5xhjqQn1bhymmDEvz8EfivCETPW7PkJso7qBe");
  });

  test("includes publicPort when the descriptor sets one", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(
      db,
      "5HYwithPort",
      descriptor({ publicHost: "miner.example.com", publicPort: 8086 }),
    );
    const fetchImpl = fakeFetch({
      "https://miner.example.com:8086/api/v1/status": {
        status: 200,
        body: { success: true, data: { ss58_address: "5HYwithPort" } },
      },
    });
    const result = await discoverLocalOperator(db, { fetchImpl });
    expect(result).toBe("5HYwithPort");
  });

  test("skips descriptors whose status reports a different ss58 (multi-tenant)", async () => {
    // Two descriptors. Only the second one's URL responds with a
    // matching ss58_address. The first looks like another operator's
    // node — probing it returns *their* SS58, not the descriptor's
    // signer — so the resolver must keep looking.
    const db = await newInMemoryAdapter();
    await seedDescriptor(
      db,
      "5HYotherOperator",
      descriptor({ nodeName: "aaa-other", publicHost: "other.example.com" }),
      "50",
    );
    await seedDescriptor(
      db,
      "5HYlocalOperator",
      descriptor({ nodeName: "bbb-local", publicHost: "local.example.com" }),
      "100",
    );
    const fetchImpl = fakeFetch({
      "https://other.example.com/api/v1/status": {
        status: 200,
        // Same node returns SOMEONE ELSE's SS58 — not the descriptor's signer.
        body: { success: true, data: { ss58_address: "5HYsomeoneEntirelyDifferent" } },
      },
      "https://local.example.com/api/v1/status": {
        status: 200,
        body: { success: true, data: { ss58_address: "5HYlocalOperator" } },
      },
    });
    const result = await discoverLocalOperator(db, { fetchImpl });
    expect(result).toBe("5HYlocalOperator");
  });

  test("returns null when no probe is self-consistent", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(db, "5HYa", descriptor({ publicHost: "a.example.com" }));
    await seedDescriptor(db, "5HYb", descriptor({ publicHost: "b.example.com" }));
    const fetchImpl = fakeFetch({
      "https://a.example.com/api/v1/status": {
        status: 200,
        body: { success: true, data: { ss58_address: "5HYsomeoneElse" } },
      },
      "https://b.example.com/api/v1/status": {
        status: 200,
        body: { success: true, data: { ss58_address: "5HYsomeoneElse" } },
      },
    });
    const result = await discoverLocalOperator(db, { fetchImpl });
    expect(result).toBeNull();
  });

  test("skips unreachable hosts (non-2xx, malformed envelope)", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(db, "5HYa", descriptor({ publicHost: "a.example.com" }));
    await seedDescriptor(db, "5HYb", descriptor({ publicHost: "b.example.com" }));
    const fetchImpl = fakeFetch({
      // 405 — substrate-RPC-like response.
      "https://a.example.com/api/v1/status": { status: 405, body: "method not allowed" },
      "https://b.example.com/api/v1/status": {
        status: 200,
        body: { success: true, data: { ss58_address: "5HYb" } },
      },
    });
    const result = await discoverLocalOperator(db, { fetchImpl });
    expect(result).toBe("5HYb");
  });

  test("caps the number of probes (avoids runaway on a large descriptor table)", async () => {
    const db = await newInMemoryAdapter();
    let calls = 0;
    // Seed more descriptors than maxProbes; none self-consistent.
    for (let i = 0; i < 20; i++) {
      await seedDescriptor(db, `5HYdummy${i}`, descriptor({ publicHost: `host-${i}.example.com` }));
    }
    const fetchImpl = (async (_input, _init) => {
      calls++;
      return new Response(
        JSON.stringify({ success: true, data: { ss58_address: "5HYnoone" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await discoverLocalOperator(db, { fetchImpl, maxProbes: 3 });
    expect(result).toBeNull();
    expect(calls).toBe(3);
  });

  test("envelope with success:false is ignored", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(db, "5HYa", descriptor({ publicHost: "a.example.com" }));
    const fetchImpl = fakeFetch({
      "https://a.example.com/api/v1/status": {
        status: 200,
        body: { success: false, error: "not ready" },
      },
    });
    const result = await discoverLocalOperator(db, { fetchImpl });
    expect(result).toBeNull();
  });
});

describe("resolveSelfMinerRestUrl", () => {
  test("uses descriptor.publicHost when selfAccountId resolves", async () => {
    const db = await newInMemoryAdapter();
    await seedDescriptor(
      db,
      "5HYwithHost",
      descriptor({ publicHost: "miner.example.com", publicPort: 8086 }),
    );
    const url = await resolveSelfMinerRestUrl(db, ["ws://validator:9944"], "5HYwithHost");
    expect(url).toBe("https://miner.example.com:8086");
  });

  test("falls back to derived RPC URL when no descriptor row exists", async () => {
    const db = await newInMemoryAdapter();
    const url = await resolveSelfMinerRestUrl(db, ["ws://validator:9944"], "5HYunknown");
    expect(url).toBe("http://validator:9944");
  });

  test("falls back when selfAccountId is null", async () => {
    const db = await newInMemoryAdapter();
    const url = await resolveSelfMinerRestUrl(db, ["wss://example.com/rpc"], null);
    expect(url).toBe("https://example.com");
  });
});
