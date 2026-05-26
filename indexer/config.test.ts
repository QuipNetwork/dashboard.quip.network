// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parseConfig } from "./config";

// parseConfig reads process.env and Bun.argv. These tests control both via
// scoped setters — don't leak env mutations into unrelated tests.
const TOUCHED_ENV = [
  "QUIP_VALIDATOR_RPC_URLS",
  "POLL_INTERVAL_SEC",
  "NODES_REFRESH_SEC",
  "STALL_WARN_AFTER_SEC",
  "VERBOSE",
  "QUIP_VALIDATOR_RPC_TIMEOUT_MS",
  "QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS",
  "QUIP_VALIDATOR_BABE_POLL_SEC",
  "QUIP_VALIDATOR_CHAIN_POLL_SEC",
  "QUIP_DESCRIPTOR_START_BLOCK",
] as const;

describe("parseConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TOUCHED_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TOUCHED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults stallWarnAfterSec to 600 when neither flag nor env is set", () => {
    const cfg = parseConfig([]);
    expect(cfg.stallWarnAfterSec).toBe(600);
  });

  it("honours --stall-warn-after=NNN", () => {
    const cfg = parseConfig(["--stall-warn-after=120"]);
    expect(cfg.stallWarnAfterSec).toBe(120);
  });

  it("honours --stall-warn-after NNN (space-separated)", () => {
    const cfg = parseConfig(["--stall-warn-after", "120"]);
    expect(cfg.stallWarnAfterSec).toBe(120);
  });

  it("honours STALL_WARN_AFTER_SEC env var", () => {
    process.env.STALL_WARN_AFTER_SEC = "42";
    expect(parseConfig([]).stallWarnAfterSec).toBe(42);
  });

  it("prefers the flag over the env var", () => {
    process.env.STALL_WARN_AFTER_SEC = "42";
    expect(parseConfig(["--stall-warn-after=99"]).stallWarnAfterSec).toBe(99);
  });

  it("accepts stallWarnAfterSec=0 (disabled by design)", () => {
    expect(parseConfig(["--stall-warn-after=0"]).stallWarnAfterSec).toBe(0);
  });

  it("rejects negative stallWarnAfterSec", () => {
    expect(() => parseConfig(["--stall-warn-after=-1"])).toThrow(/>= 0/);
  });

  it("rejects non-integer stallWarnAfterSec (floats)", () => {
    expect(() => parseConfig(["--stall-warn-after=1.5"])).toThrow(/decimal integer/);
  });

  it("rejects whitespace-only env var instead of silently disabling", () => {
    // The old Number()-based parser turned " " into 0, which disabled
    // stall detection without any warning in the startup log.
    process.env.STALL_WARN_AFTER_SEC = "   ";
    expect(() => parseConfig([])).toThrow(/decimal integer/);
  });

  it("rejects hex and scientific notation", () => {
    // These would have coerced via Number() in the old parser: "0x10" → 16,
    // "1e3" → 1000. Both silently, with no diagnostic trail.
    expect(() => parseConfig(["--stall-warn-after=0x10"])).toThrow(/decimal integer/);
    expect(() => parseConfig(["--stall-warn-after=1e3"])).toThrow(/decimal integer/);
  });

  it("tolerates surrounding whitespace in env values", () => {
    // Copy-paste and YAML quoting artefacts shouldn't break startup.
    process.env.STALL_WARN_AFTER_SEC = "  600  ";
    expect(parseConfig([]).stallWarnAfterSec).toBe(600);
  });

  it("defaults validatorRpcUrls to docker-compose service name", () => {
    const cfg = parseConfig([]);
    expect(cfg.validatorRpcUrls).toEqual(["ws://quip-validator:9944"]);
    expect(cfg.substrateRpcTimeoutMs).toBe(15000);
    expect(cfg.substrateReconnectMaxBackoffMs).toBe(60000);
    expect(cfg.substrateBabePollSec).toBe(30);
    // Matches BABE slot duration on quip-protocol-rs spec 101.
    expect(cfg.substrateChainPollSec).toBe(6);
    // Backfills from genesis by default; long-lived chains override via env.
    expect(cfg.descriptorStartBlock).toBe("1");
  });

  it("honours QUIP_DESCRIPTOR_START_BLOCK env var", () => {
    process.env.QUIP_DESCRIPTOR_START_BLOCK = "5000";
    expect(parseConfig([]).descriptorStartBlock).toBe("5000");
  });

  it("honours --descriptor-start-block flag (overrides env)", () => {
    process.env.QUIP_DESCRIPTOR_START_BLOCK = "5000";
    expect(parseConfig(["--descriptor-start-block=9000"]).descriptorStartBlock).toBe("9000");
  });

  it("rejects descriptorStartBlock < 1", () => {
    expect(() => parseConfig(["--descriptor-start-block=0"])).toThrow(/>= 1/);
  });

  it("reads QUIP_VALIDATOR_RPC_URLS from env (single entry)", () => {
    process.env.QUIP_VALIDATOR_RPC_URLS = "ws://my-validator:9944";
    expect(parseConfig([]).validatorRpcUrls).toEqual(["ws://my-validator:9944"]);
  });

  it("splits QUIP_VALIDATOR_RPC_URLS on commas, trimming whitespace", () => {
    process.env.QUIP_VALIDATOR_RPC_URLS =
      "ws://primary:9944 , wss://secondary.example/rpc, ws://fallback:9944";
    expect(parseConfig([]).validatorRpcUrls).toEqual([
      "ws://primary:9944",
      "wss://secondary.example/rpc",
      "ws://fallback:9944",
    ]);
  });

  it("strips trailing slashes from each rpc url", () => {
    process.env.QUIP_VALIDATOR_RPC_URLS = "wss://example.com/rpc/,ws://other:9944/";
    expect(parseConfig([]).validatorRpcUrls).toEqual(["wss://example.com/rpc", "ws://other:9944"]);
  });

  it("ignores empty entries from leading/trailing/double commas", () => {
    process.env.QUIP_VALIDATOR_RPC_URLS = ",ws://valid:9944,,";
    expect(parseConfig([]).validatorRpcUrls).toEqual(["ws://valid:9944"]);
  });

  it("falls back to defaults when env var is empty / whitespace", () => {
    process.env.QUIP_VALIDATOR_RPC_URLS = "   ";
    expect(parseConfig([]).validatorRpcUrls).toEqual(["ws://quip-validator:9944"]);
  });

  it("rejects env vars that are non-empty but contain no usable urls", () => {
    // Edge case: all entries got stripped (e.g. ",,,," or whitespace
    // around empty slots). Operators almost certainly meant something
    // — fail loudly instead of silently dropping to the default.
    process.env.QUIP_VALIDATOR_RPC_URLS = ",,,";
    expect(() => parseConfig([])).toThrow(/no usable entries/);
  });

  it("honours --validator-rpc-urls flag (overrides env)", () => {
    process.env.QUIP_VALIDATOR_RPC_URLS = "ws://env:9944";
    expect(
      parseConfig(["--validator-rpc-urls=ws://flag:9944,ws://flag2:9944"]).validatorRpcUrls,
    ).toEqual(["ws://flag:9944", "ws://flag2:9944"]);
  });

  it("parses substrate poll intervals from env", () => {
    process.env.QUIP_VALIDATOR_BABE_POLL_SEC = "60";
    process.env.QUIP_VALIDATOR_CHAIN_POLL_SEC = "600";
    process.env.QUIP_VALIDATOR_RPC_TIMEOUT_MS = "20000";
    process.env.QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS = "120000";
    const cfg = parseConfig([]);
    expect(cfg.substrateBabePollSec).toBe(60);
    expect(cfg.substrateChainPollSec).toBe(600);
    expect(cfg.substrateRpcTimeoutMs).toBe(20000);
    expect(cfg.substrateReconnectMaxBackoffMs).toBe(120000);
  });

  it("rejects non-positive substrate poll intervals", () => {
    expect(() => parseConfig(["--substrate-babe-poll=0"])).toThrow(/> 0/);
    expect(() => parseConfig(["--substrate-chain-poll=-1"])).toThrow(/> 0/);
  });
});
