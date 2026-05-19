// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { parseIndexerObservability } from "./adapter";

describe("parseIndexerObservability", () => {
  it("parses a valid v5 blob with substrate fields", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      tipEpoch: "abc123",
      tipBlockIndex: 42,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      nodesObservedAt: "2026-04-23T00:00:30.000Z",
      lastSubstrateEventAt: "2026-05-15T00:00:00.000Z",
      bestBlockHeight: "12345",
      finalizedBlockHeight: "12343",
      chainConnected: true,
    });
    const parsed = parseIndexerObservability(blob, "sqlite");
    expect(parsed).not.toBeNull();
    expect(parsed!.tipEpoch).toBe("abc123");
    expect(parsed!.backfillEpoch).toBeNull();
    expect(parsed!.backfillBlockIndex).toBe(0);
    expect(parsed!.chainConnected).toBe(true);
    expect(parsed!.bestBlockHeight).toBe("12345");
    expect(parsed!.lastSubstrateEventAt).toBe("2026-05-15T00:00:00.000Z");
    expect(parsed!.nodesObservedAt).toBe("2026-04-23T00:00:30.000Z");
  });

  it("rejects v4 blobs missing substrate fields (forces refresh on first poll)", () => {
    const v4Blob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      tipEpoch: "abc123",
      tipBlockIndex: 42,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    expect(parseIndexerObservability(v4Blob, "sqlite")).toBeNull();
  });

  it("rejects blobs missing nodesObservedAt (audit #6)", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      // nodesObservedAt: missing
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });

  it("rejects old-shape blobs (cursorEpoch/cursorBlockIndex)", () => {
    const oldBlob = JSON.stringify({
      nodeLatestEpoch: "abc123",
      nodeLatestBlockIndex: 42,
      cursorEpoch: "abc123",
      cursorBlockIndex: 42,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
    });
    expect(parseIndexerObservability(oldBlob, "sqlite")).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseIndexerObservability("{not json", "sqlite")).toBeNull();
  });

  it("rejects blobs missing backfill fields", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: false,
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });

  it("rejects blobs with non-boolean chainConnected", () => {
    const blob = JSON.stringify({
      nodeLatestEpoch: "abc",
      nodeLatestBlockIndex: 1,
      tipEpoch: "abc",
      tipBlockIndex: 1,
      backfillEpoch: null,
      backfillBlockIndex: 0,
      lastStatusFetchAt: "2026-04-23T00:00:00.000Z",
      lastBlockInsertAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: "yes", // wrong type
    });
    expect(parseIndexerObservability(blob, "sqlite")).toBeNull();
  });
});
