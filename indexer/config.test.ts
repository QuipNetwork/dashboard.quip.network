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
  "BACKFILL_IDLE_RECHECK_SEC",
  "VERBOSE",
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

  it("parses --backfill-idle-recheck flag", () => {
    const cfg = parseConfig(["--backfill-idle-recheck", "120"]);
    expect(cfg.backfillIdleRecheckSec).toBe(120);
  });

  it("reads BACKFILL_IDLE_RECHECK_SEC env var", () => {
    const orig = process.env.BACKFILL_IDLE_RECHECK_SEC;
    process.env.BACKFILL_IDLE_RECHECK_SEC = "60";
    try {
      const cfg = parseConfig([]);
      expect(cfg.backfillIdleRecheckSec).toBe(60);
    } finally {
      if (orig === undefined) delete process.env.BACKFILL_IDLE_RECHECK_SEC;
      else process.env.BACKFILL_IDLE_RECHECK_SEC = orig;
    }
  });

  it("defaults backfillIdleRecheckSec to 300", () => {
    const cfg = parseConfig([]);
    expect(cfg.backfillIdleRecheckSec).toBe(300);
  });
});
