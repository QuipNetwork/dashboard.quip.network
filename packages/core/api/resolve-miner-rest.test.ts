// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import type { NodeDescriptorRecord } from "@quip/shared/telemetry";

import {
  deriveMinerRestFromRpcUrl,
  resolvePeerMinerRestUrl,
  resolveSelfMinerRestUrl,
} from "./resolve-miner-rest";

function descriptorWith(host: string | undefined, port: number | undefined): NodeDescriptorRecord {
  return {
    accountId: "5GPeer",
    blockNumber: "1",
    blockHash: "0xb",
    extrinsicIndex: 0,
    blockTimestamp: 0,
    firstBlockTimestamp: 0,
    observedAt: "2026-06-30T00:00:00Z",
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: "peer",
      ...(host === undefined ? {} : { publicHost: host }),
      ...(port === undefined ? {} : { publicPort: port }),
    },
  };
}

describe("resolveSelfMinerRestUrl", () => {
  test("derives the miner-REST base URL from the configured front door", () => {
    expect(resolveSelfMinerRestUrl(["ws://quip-caddy:8088/rpc"])).toBe("http://quip-caddy:8088");
  });

  test("uses the first validator RPC URL when several are configured", () => {
    expect(resolveSelfMinerRestUrl(["ws://validator:9944", "ws://other:9944"])).toBe(
      "http://validator:9944",
    );
  });

  test("is local-network-only — never consults on-chain descriptors for 'self'", () => {
    // No DB is involved at all: a reachable public node on chain is not us, so
    // identity is resolved solely from the configured local front door.
    expect(resolveSelfMinerRestUrl(["wss://example.com/rpc"])).toBe("https://example.com");
  });

  test("returns null when no front door is configured", () => {
    expect(resolveSelfMinerRestUrl([])).toBeNull();
  });
});

describe("resolvePeerMinerRestUrl", () => {
  test("derives http://host:port from a descriptor's advertised endpoint", () => {
    expect(resolvePeerMinerRestUrl(descriptorWith("1.2.3.4", 8088))).toBe("http://1.2.3.4:8088");
  });

  test("uses https when the advertised port is 443", () => {
    expect(resolvePeerMinerRestUrl(descriptorWith("node.example.com", 443))).toBe(
      "https://node.example.com:443",
    );
  });

  test("omits the port when the descriptor advertises none", () => {
    expect(resolvePeerMinerRestUrl(descriptorWith("node.example.com", undefined))).toBe(
      "http://node.example.com",
    );
  });

  test("normalizes a host that already carries a scheme", () => {
    expect(resolvePeerMinerRestUrl(descriptorWith("https://node.example.com", 9000))).toBe(
      "https://node.example.com:9000",
    );
  });

  test("returns null when there is no descriptor or no advertised host", () => {
    expect(resolvePeerMinerRestUrl(null)).toBeNull();
    expect(resolvePeerMinerRestUrl(descriptorWith(undefined, 8088))).toBeNull();
    expect(resolvePeerMinerRestUrl(descriptorWith("   ", 8088))).toBeNull();
  });
});

describe("deriveMinerRestFromRpcUrl", () => {
  test("ws → http and strips a trailing /rpc", () => {
    expect(deriveMinerRestFromRpcUrl("ws://quip-caddy:8088/rpc")).toBe("http://quip-caddy:8088");
  });

  test("ws → http with no /rpc to strip", () => {
    expect(deriveMinerRestFromRpcUrl("ws://quip-validator:9944")).toBe(
      "http://quip-validator:9944",
    );
  });

  test("wss → https and strips /rpc", () => {
    expect(deriveMinerRestFromRpcUrl("wss://example.com/rpc")).toBe("https://example.com");
  });

  test("keeps a path segment that follows /rpc", () => {
    expect(deriveMinerRestFromRpcUrl("wss://example.com:443/rpc/ws")).toBe(
      "https://example.com:443/ws",
    );
  });
});
