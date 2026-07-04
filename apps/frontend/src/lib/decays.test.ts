// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { blocksSinceLastProof, decaysApplied } from "./decays";

function head(best: string, finalized: string) {
  return { bestBlockNumber: best, finalizedBlockNumber: finalized };
}

describe("blocksSinceLastProof", () => {
  it("anchors on the best head, not finality", () => {
    // Incident shape (2026-07-04): finality stalled ~600 blocks behind
    // best while decays kept applying with the executing chain.
    expect(blocksSinceLastProof(head("545513", "544900"), "544858")).toBe(655);
  });

  it("falls back to finalized when best is absent", () => {
    expect(blocksSinceLastProof(head("", "545000"), "544858")).toBe(142);
  });

  it("clamps to zero when the anchor is ahead of the head", () => {
    expect(blocksSinceLastProof(head("100", "100"), "150")).toBe(0);
  });

  it("returns null on missing inputs", () => {
    expect(blocksSinceLastProof(null, "100")).toBeNull();
    expect(blocksSinceLastProof(head("100", "100"), null)).toBeNull();
    expect(blocksSinceLastProof(head("", ""), "100")).toBeNull();
    expect(blocksSinceLastProof(head("not-a-number", ""), "100")).toBeNull();
  });
});

describe("decaysApplied", () => {
  it("counts one step per epoch (100 blocks) past the last proof", () => {
    expect(decaysApplied(head("545513", "544900"), "544858")).toBe(6);
    expect(decaysApplied(head("544957", "544957"), "544858")).toBe(0);
    expect(decaysApplied(head("544958", "544958"), "544858")).toBe(1);
  });

  it("would have shown the incident's stalled-finality undercount as 0", () => {
    // The old finalized-anchored formula: floor((544900-544858)/100) = 0.
    // The best-anchored one reports the real decay count.
    expect(decaysApplied(head("545513", "544900"), "544858")).toBe(6);
  });

  it("returns null on missing inputs", () => {
    expect(decaysApplied(null, "100")).toBeNull();
    expect(decaysApplied(head("100", "100"), null)).toBeNull();
  });
});
