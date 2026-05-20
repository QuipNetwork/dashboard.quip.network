// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parseConfig } from "./config";

// parseConfig reads process.env and Bun.argv. These tests control both via
// scoped setters — don't leak env mutations into unrelated tests.
const TOUCHED_ENV = [
  "QUIP_NODE_URL",
  "QUIP_NODE_TOKEN",
  "POLL_INTERVAL_SEC",
  "NODES_REFRESH_SEC",
  "STALL_WARN_AFTER_SEC",
  "VERBOSE",
  "QUIP_VALIDATOR_RPC_URL",
  "QUIP_VALIDATOR_RPC_TIMEOUT_MS",
  "QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS",
  "QUIP_VALIDATOR_BABE_POLL_SEC",
  "QUIP_VALIDATOR_CHAIN_POLL_SEC",
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

  it("defaults substrateRpcUrl to null (degraded mode)", () => {
    const cfg = parseConfig([]);
    expect(cfg.substrateRpcUrl).toBeNull();
    expect(cfg.substrateRpcTimeoutMs).toBe(15000);
    expect(cfg.substrateReconnectMaxBackoffMs).toBe(60000);
    expect(cfg.substrateBabePollSec).toBe(30);
    expect(cfg.substrateChainPollSec).toBe(300);
  });

  it("reads QUIP_VALIDATOR_RPC_URL from env", () => {
    process.env.QUIP_VALIDATOR_RPC_URL = "ws://quip-validator:9944";
    expect(parseConfig([]).substrateRpcUrl).toBe("ws://quip-validator:9944");
  });

  it("honours --substrate-rpc-url flag", () => {
    const cfg = parseConfig(["--substrate-rpc-url", "wss://x.example/rpc"]);
    expect(cfg.substrateRpcUrl).toBe("wss://x.example/rpc");
  });

  it("flag overrides env for substrate fields", () => {
    process.env.QUIP_VALIDATOR_RPC_URL = "ws://env";
    expect(parseConfig(["--substrate-rpc-url=ws://flag"]).substrateRpcUrl).toBe("ws://flag");
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

  it("rejects empty substrate-rpc-url (use unset/omit for degraded mode)", () => {
    // Empty string would otherwise look "set" but produce a wss:// connect
    // failure deep in the worker; reject at config time.
    expect(() => parseConfig(["--substrate-rpc-url="])).toThrow(/empty/);
  });
});
