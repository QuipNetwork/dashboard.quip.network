// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { BoundedKeySet } from "./bounded-key-set";

describe("BoundedKeySet", () => {
  it("remembers added keys and forgets unknown ones", () => {
    const s = new BoundedKeySet(10);
    s.add("a");
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });

  it("deletes a key from either generation", () => {
    const s = new BoundedKeySet(4);
    s.add("a");
    s.delete("a");
    expect(s.has("a")).toBe(false);
  });

  it("never retains more than twice the cap, however many keys are added", () => {
    const cap = 8;
    const s = new BoundedKeySet(cap);
    for (let i = 0; i < 1000; i++) s.add(`k${i}`);
    expect(s.size).toBeLessThanOrEqual(2 * cap);
  });

  it("retains recent keys and evicts the oldest after enough churn", () => {
    const cap = 8;
    const s = new BoundedKeySet(cap);
    for (let i = 0; i < 1000; i++) s.add(`k${i}`);
    expect(s.has("k999")).toBe(true);
    expect(s.has("k0")).toBe(false);
  });

  it("still dedupes a key one generation after it was added", () => {
    const cap = 8;
    const s = new BoundedKeySet(cap);
    s.add("keep");
    // Fill the current generation so "keep" rotates into the previous one.
    for (let i = 0; i < cap; i++) s.add(`x${i}`);
    expect(s.has("keep")).toBe(true);
  });
});
