// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { IndexerObservability } from "@quip/shared/telemetry";

import { IndexerState } from "./state";
import { newInMemoryAdapter } from "./test-helpers";

describe("IndexerState observability persistence", () => {
  let adapter: DatabaseAdapter | null = null;
  afterEach(async () => {
    if (adapter) await adapter.disconnect();
    adapter = null;
  });

  it("loads default observability on empty DB", async () => {
    adapter = await newInMemoryAdapter();
    const state = new IndexerState(adapter);
    await state.load();
    expect(state.observability.chainHeadFromNode).toBeNull();
    expect(state.observability.minerStats).toBeNull();
    expect(state.observability.chainConnected).toBe(false);
  });

  it("seeds observability from prior DB row but resets chainConnected", async () => {
    // chainConnected is a live WSS state — seeding it from the DB after a
    // restart would lie to the SyncIndicator until the substrate worker's
    // first reconnect event fires.
    adapter = await newInMemoryAdapter();
    const seed: IndexerObservability = {
      chainHeadFromNode: "4939",
      lastStatusFetchAt: "2026-05-19T00:00:00.000Z",
      lastBlockInsertAt: "2026-05-19T00:00:00.000Z",
      lastSubstrateEventAt: "2026-05-19T00:00:00.000Z",
      bestBlockHeight: "100",
      finalizedBlockHeight: "99",
      chainConnected: true, // stored, but must NOT be reflected on load
      minerStats: null,
      modes: {},
    };
    await adapter.setIndexerObservability(seed);

    const state = new IndexerState(adapter);
    await state.load();
    expect(state.observability.chainHeadFromNode).toBe("4939");
    expect(state.observability.bestBlockHeight).toBe("100");
    expect(state.observability.finalizedBlockHeight).toBe("99");
    expect(state.observability.chainConnected).toBe(false);
  });

  it("load() resets sync-gate fields like chainConnected", async () => {
    adapter = await newInMemoryAdapter();
    await adapter.setIndexerObservability({
      chainHeadFromNode: "100",
      lastStatusFetchAt: new Date().toISOString(),
      lastBlockInsertAt: null,
      lastSubstrateEventAt: null,
      bestBlockHeight: null,
      finalizedBlockHeight: null,
      chainConnected: true,
      minerStats: null,
      nodeSyncing: true,
      nodeSyncCurrentBlock: "406173",
      nodeSyncHighestBlock: "512000",
    });
    const state = new IndexerState(adapter);
    await state.load();
    expect(state.observability.nodeSyncing).toBe(false);
    expect(state.observability.nodeSyncCurrentBlock).toBeNull();
    expect(state.observability.nodeSyncHighestBlock).toBeNull();
    await adapter.disconnect();
  });
});
