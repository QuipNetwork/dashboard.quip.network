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
    modes: {},
  };

  test("accepts a well-formed v6 payload", () => {
    expect(parseIndexerObservability(JSON.stringify(sample))).toEqual(sample);
  });

  test("accepts a populated minerStats sub-object", () => {
    const withStats = {
      ...sample,
      minerStats: {
        headsObserved: 23,
        contextsDispatched: 46,
        resultsReceived: 0,
        proofsSubmitted: 0,
        staleDrops: 0,
        submissionErrors: 0,
      },
    };
    const parsed = parseIndexerObservability(JSON.stringify(withStats));
    expect(parsed?.minerStats?.headsObserved).toBe(23);
  });

  test("returns null for malformed JSON", () => {
    expect(parseIndexerObservability("not json")).toBeNull();
    expect(parseIndexerObservability("[]")).toBeNull();
    expect(parseIndexerObservability("null")).toBeNull();
  });

  test("returns null when lastStatusFetchAt missing", () => {
    const bad = { ...sample } as Partial<typeof sample>;
    delete bad.lastStatusFetchAt;
    expect(parseIndexerObservability(JSON.stringify(bad))).toBeNull();
  });

  test("returns null when chainConnected has wrong type", () => {
    const bad = { ...sample, chainConnected: "false" };
    expect(parseIndexerObservability(JSON.stringify(bad))).toBeNull();
  });

  test("returns null when chainHeadFromNode is a number instead of string|null", () => {
    const bad = { ...sample, chainHeadFromNode: 4939 };
    expect(parseIndexerObservability(JSON.stringify(bad))).toBeNull();
  });

  test("malformed minerStats degrades to null minerStats, not full rejection", () => {
    // The v6 contract: minerStats is best-effort. A malformed sub-object
    // shouldn't fail the whole parse — it should just drop minerStats.
    const malformed = { ...sample, minerStats: { foo: "bar" } };
    const parsed = parseIndexerObservability(JSON.stringify(malformed));
    expect(parsed).not.toBeNull();
    expect(parsed?.minerStats).toBeNull();
  });

  test("returns null when bestBlockHeight is a number instead of string|null", () => {
    const bad = { ...sample, bestBlockHeight: 999 };
    expect(parseIndexerObservability(JSON.stringify(bad))).toBeNull();
  });

  test("round-trips the optional `indexer` backfill-progress field (spec §11)", () => {
    const withIndexer = {
      ...sample,
      indexer: {
        backfillQueueDepth: 3,
        coverage: {
          winners: {
            low: "394362",
            high: "530752",
            gapBlocks: 0,
            prunedFloor: null,
            topologyEnrichmentFloor: null,
            generation: 1,
          },
          authorship: {
            low: "100000",
            high: "530752",
            gapBlocks: 2,
            prunedFloor: "99999",
            topologyEnrichmentFloor: null,
            generation: 2,
          },
        },
        difficultyDataStartBlock: "394362",
      },
    };
    const parsed = parseIndexerObservability(JSON.stringify(withIndexer));
    expect(parsed?.indexer).toEqual(withIndexer.indexer);
  });

  test("tolerates absence of `indexer` (pre-redesign rows)", () => {
    const parsed = parseIndexerObservability(JSON.stringify(sample));
    expect(parsed).not.toBeNull();
    expect(parsed?.indexer).toBeUndefined();
  });

  test("malformed `indexer` degrades to undefined, not full rejection", () => {
    const malformed = { ...sample, indexer: { backfillQueueDepth: "nope" } };
    const parsed = parseIndexerObservability(JSON.stringify(malformed));
    expect(parsed).not.toBeNull();
    expect(parsed?.indexer).toBeUndefined();
  });
});
