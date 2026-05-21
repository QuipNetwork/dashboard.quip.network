// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { parseIndexerObservability } from "./adapter";

describe("parseIndexerObservability (v6)", () => {
  const sample = {
    chainHeadFromNode: "4939",
    lastStatusFetchAt: "2026-05-19T00:00:00Z",
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: false,
    minerStats: null,
  };

  test("accepts a well-formed v6 payload", () => {
    expect(parseIndexerObservability(JSON.stringify(sample), "sqlite")).toEqual(sample);
  });

  test("accepts a populated minerStats sub-object", () => {
    const withStats = {
      ...sample,
      minerStats: {
        totalBlocksAttempted: 23,
        totalBlocksWon: 0,
        winRate: 0,
        totalMiningTime: 0,
        avgMiningTime: 0,
        headsObserved: 23,
        contextsDispatched: 46,
        resultsReceived: 0,
        proofsSubmitted: 0,
        staleDrops: 0,
        submissionErrors: 0,
      },
    };
    const parsed = parseIndexerObservability(JSON.stringify(withStats), "sqlite");
    expect(parsed?.minerStats?.headsObserved).toBe(23);
  });

  test("returns null for malformed JSON", () => {
    expect(parseIndexerObservability("not json", "sqlite")).toBeNull();
    expect(parseIndexerObservability("[]", "sqlite")).toBeNull();
    expect(parseIndexerObservability("null", "sqlite")).toBeNull();
  });

  test("returns null when lastStatusFetchAt missing", () => {
    const bad = { ...sample } as Partial<typeof sample>;
    delete bad.lastStatusFetchAt;
    expect(parseIndexerObservability(JSON.stringify(bad), "sqlite")).toBeNull();
  });

  test("returns null when chainConnected has wrong type", () => {
    const bad = { ...sample, chainConnected: "false" };
    expect(parseIndexerObservability(JSON.stringify(bad), "sqlite")).toBeNull();
  });

  test("returns null when chainHeadFromNode is a number instead of string|null", () => {
    const bad = { ...sample, chainHeadFromNode: 4939 };
    expect(parseIndexerObservability(JSON.stringify(bad), "sqlite")).toBeNull();
  });

  test("malformed minerStats degrades to null minerStats, not full rejection", () => {
    // The v6 contract: minerStats is best-effort. A malformed sub-object
    // shouldn't fail the whole parse — it should just drop minerStats.
    const malformed = { ...sample, minerStats: { foo: "bar" } };
    const parsed = parseIndexerObservability(JSON.stringify(malformed), "sqlite");
    expect(parsed).not.toBeNull();
    expect(parsed?.minerStats).toBeNull();
  });

  test("returns null when bestBlockHeight is a number instead of string|null", () => {
    const bad = { ...sample, bestBlockHeight: 999 };
    expect(parseIndexerObservability(JSON.stringify(bad), "sqlite")).toBeNull();
  });
});
