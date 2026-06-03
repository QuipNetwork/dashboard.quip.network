// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { deriveMinerRestFromRpcUrl, resolveSelfMinerRestUrl } from "./resolve-miner-rest";

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
