// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "bun:test";
import { SQLiteAdapter } from "../api/db/sqlite";
import { IndexerState } from "./state";

describe("IndexerState two-cursor persistence", () => {
  let adapter: SQLiteAdapter | null = null;
  afterEach(async () => {
    if (adapter) await adapter.disconnect();
    adapter = null;
  });

  it("loads fresh defaults on empty DB", async () => {
    adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
    await adapter.connect();
    await adapter.migrate();
    const state = new IndexerState(adapter);
    await state.load();
    expect(state.tipCursor).toEqual({ epoch: null, blockIndex: 0 });
    expect(state.backfillCursor).toEqual({ epoch: null, blockIndex: 0 });
  });

  it("round-trips tip + backfill cursors via save()", async () => {
    adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
    await adapter.connect();
    await adapter.migrate();
    const state = new IndexerState(adapter);
    await state.load();
    state.tipCursor = { epoch: "tip-epoch", blockIndex: 7 };
    state.backfillCursor = { epoch: "bf-epoch", blockIndex: 3 };
    state.etags.nodes = "etag-xyz";
    await state.save();

    const reloaded = new IndexerState(adapter);
    await reloaded.load();
    expect(reloaded.tipCursor).toEqual({ epoch: "tip-epoch", blockIndex: 7 });
    expect(reloaded.backfillCursor).toEqual({ epoch: "bf-epoch", blockIndex: 3 });
    expect(reloaded.etags.nodes).toBe("etag-xyz");
  });
});
