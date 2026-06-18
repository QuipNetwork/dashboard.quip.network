// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { chunk } from "./array";

describe("chunk", () => {
  it("splits into consecutive chunks of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("returns one chunk when size >= length", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("preserves all elements in order across many chunks", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const chunks = chunk(items, 7);
    expect(chunks.every((c) => c.length <= 7)).toBe(true);
    expect(chunks.flat()).toEqual(items);
  });

  it("rejects a size below 1", () => {
    expect(() => chunk([1], 0)).toThrow(/size/);
  });
});
