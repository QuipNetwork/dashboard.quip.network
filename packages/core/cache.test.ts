// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { TtlCache, type ICache } from "./cache";

// A controllable clock so freshness windows are deterministic.
function fakeClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

// Build function that records how many times it ran and yields distinct values.
function counter(prefix = "v"): { build: () => Promise<string>; calls: () => number } {
  let n = 0;
  return {
    build: async () => `${prefix}${++n}`,
    calls: () => n,
  };
}

describe("TtlCache", () => {
  it("builds once and serves the cached value within the TTL", async () => {
    const clock = fakeClock();
    const cache: ICache<string> = new TtlCache({ ttlMs: 1000, now: clock.now });
    const c = counter();

    expect(await cache.read("k", c.build)).toBe("v1");
    clock.advance(500); // still fresh
    expect(await cache.read("k", c.build)).toBe("v1");
    expect(c.calls()).toBe(1);
  });

  it("rebuilds once the TTL expires", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1000, now: clock.now });
    const c = counter();

    expect(await cache.read("k", c.build)).toBe("v1");
    clock.advance(1000); // now() - at == ttl → expired (window is exclusive)
    expect(await cache.read("k", c.build)).toBe("v2");
    expect(c.calls()).toBe(2);
  });

  it("dedupes concurrent misses into a single build (singleflight)", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1000, now: clock.now });
    let calls = 0;
    const build = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "shared";
    };

    const results = await Promise.all(Array.from({ length: 25 }, () => cache.read("k", build)));
    expect(results.every((r) => r === "shared")).toBe(true);
    expect(calls).toBe(1);
  });

  it("isolates entries by key", async () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, now: fakeClock().now });
    const a = counter("a");
    const b = counter("b");

    expect(await cache.read("a", a.build)).toBe("a1");
    expect(await cache.read("b", b.build)).toBe("b1");
    expect(await cache.read("a", a.build)).toBe("a1");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("forces a rebuild after invalidate()", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1000, now: clock.now });
    const c = counter();

    expect(await cache.read("k", c.build)).toBe("v1");
    cache.invalidate("k");
    expect(await cache.read("k", c.build)).toBe("v2");
    expect(c.calls()).toBe(2);
  });

  it("does not cache a failed build and retries on the next read", async () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, now: fakeClock().now });
    let attempt = 0;
    const build = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return "ok";
    };

    await expect(cache.read("k", build)).rejects.toThrow("boom");
    expect(await cache.read("k", build)).toBe("ok"); // not poisoned by the failure
    expect(attempt).toBe(2);
  });

  it("rebuilds every sequential read when ttlMs is 0 (cache disabled)", async () => {
    const cache = new TtlCache<string>({ ttlMs: 0, now: fakeClock().now });
    const c = counter();

    expect(await cache.read("k", c.build)).toBe("v1");
    expect(await cache.read("k", c.build)).toBe("v2");
    expect(c.calls()).toBe(2);
  });
});
