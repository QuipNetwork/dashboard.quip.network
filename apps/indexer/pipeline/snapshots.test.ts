// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SnapshotScheduler sync gating (design 2026-07-04): gated ticks are
// skipped without consuming --once's take(1); resume$ re-polls promptly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Subject } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { FakeSubstrateClient } from "../clients/substrate-client";
import { IndexerState } from "../core/state";
import { makeConfig, newInMemoryAdapter } from "../core/test-helpers";
import type { SnapshotIndexable } from "./plugin";
import { SnapshotScheduler } from "./snapshots";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function countingPlugin(calls: { n: number }): SnapshotIndexable {
  return {
    name: "counting",
    kind: "snapshot",
    intervalSec: () => 1_000, // never re-ticks within a test
    poll: async () => {
      calls.n += 1;
    },
    dropState: async () => {},
  };
}

let db: DatabaseAdapter;
beforeEach(async () => {
  db = await newInMemoryAdapter();
});
afterEach(async () => {
  await db.disconnect();
});

function makeScheduler(opts: {
  calls: { n: number };
  gated: () => boolean;
  resume$?: Subject<void>;
  once?: boolean;
}) {
  return new SnapshotScheduler({
    client: new FakeSubstrateClient(),
    db,
    state: new IndexerState(db),
    config: makeConfig(),
    snapshots: [countingPlugin(opts.calls)],
    once: opts.once,
    gated: opts.gated,
    resume$: opts.resume$,
  });
}

describe("SnapshotScheduler sync gating", () => {
  test("gated leading tick polls nothing; ungated leading tick polls", async () => {
    const gatedCalls = { n: 0 };
    const openCalls = { n: 0 };
    const sub1 = makeScheduler({ calls: gatedCalls, gated: () => true })
      .stream()
      .subscribe();
    const sub2 = makeScheduler({ calls: openCalls, gated: () => false })
      .stream()
      .subscribe();
    await wait(30);
    expect(gatedCalls.n).toBe(0);
    expect(openCalls.n).toBe(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("under --once a gated leading tick does NOT consume take(1); resume$ delivers the poll", async () => {
    let gated = true;
    const resume$ = new Subject<void>();
    const calls = { n: 0 };
    const sub = makeScheduler({ calls, gated: () => gated, resume$, once: true })
      .stream()
      .subscribe();
    await wait(20);
    expect(calls.n).toBe(0);
    gated = false;
    resume$.next();
    await wait(20);
    expect(calls.n).toBe(1);
    sub.unsubscribe();
  });
});
