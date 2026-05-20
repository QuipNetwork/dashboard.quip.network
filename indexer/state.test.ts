// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "bun:test";

import { SQLiteAdapter } from "../api/db/sqlite";
import type { IndexerObservability } from "../src/types/telemetry";

import { IndexerState } from "./state";

describe("IndexerState observability persistence", () => {
  let adapter: SQLiteAdapter | null = null;
  afterEach(async () => {
    if (adapter) await adapter.disconnect();
    adapter = null;
  });

  it("loads default observability on empty DB", async () => {
    adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
    await adapter.connect();
    await adapter.migrate();
    const state = new IndexerState(adapter);
    await state.load();
    expect(state.observability.chainHeadFromNode).toBeNull();
    expect(state.observability.minerStats).toBeNull();
    expect(state.observability.chainConnected).toBe(false);
    expect(state.pendingWinnerEvents.size).toBe(0);
  });

  it("seeds observability from prior DB row but resets chainConnected", async () => {
    // chainConnected is a live WSS state — seeding it from the DB after a
    // restart would lie to the SyncIndicator until the substrate worker's
    // first reconnect event fires.
    adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
    await adapter.connect();
    await adapter.migrate();
    const seed: IndexerObservability = {
      chainHeadFromNode: "4939",
      lastStatusFetchAt: "2026-05-19T00:00:00.000Z",
      lastBlockInsertAt: "2026-05-19T00:00:00.000Z",
      lastSubstrateEventAt: "2026-05-19T00:00:00.000Z",
      bestBlockHeight: "100",
      finalizedBlockHeight: "99",
      chainConnected: true, // stored, but must NOT be reflected on load
      minerStats: null,
    };
    await adapter.setIndexerObservability(seed);

    const state = new IndexerState(adapter);
    await state.load();
    expect(state.observability.chainHeadFromNode).toBe("4939");
    expect(state.observability.bestBlockHeight).toBe("100");
    expect(state.observability.finalizedBlockHeight).toBe("99");
    expect(state.observability.chainConnected).toBe(false);
  });
});
