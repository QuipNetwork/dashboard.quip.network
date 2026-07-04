// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SyncGate (design 2026-07-04): hysteresis (close on first syncing poll,
// open only after 2 consecutive synced polls), error handling (keep last
// state), resume signaling, and observability publication.

import { describe, expect, test } from "bun:test";

import type { IndexerObservability } from "@quip/shared/telemetry";

import type { SyncStateInfo } from "../clients/substrate-client";
import { SyncGate } from "./sync-gate";

function makeObservability(): IndexerObservability {
  return {
    chainHeadFromNode: null,
    lastStatusFetchAt: new Date(0).toISOString(),
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: true,
    minerStats: null,
    nodeSyncing: false,
    nodeSyncCurrentBlock: null,
    nodeSyncHighestBlock: null,
  };
}

function makeGate(opts: { onResume?: () => void } = {}) {
  let next: SyncStateInfo | Error = {
    isSyncing: false,
    peers: 1,
    currentBlock: null,
    highestBlock: null,
  };
  const observability = makeObservability();
  const gate = new SyncGate({
    client: {
      getSyncState: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
    },
    state: { observability },
    onResume: opts.onResume,
  });
  return {
    gate,
    observability,
    set: (v: SyncStateInfo | Error) => {
      next = v;
    },
  };
}

const syncing = (cur: number | null = null, high: number | null = null): SyncStateInfo => ({
  isSyncing: true,
  peers: 2,
  currentBlock: cur,
  highestBlock: high,
});
const synced = (): SyncStateInfo => ({
  isSyncing: false,
  peers: 2,
  currentBlock: null,
  highestBlock: null,
});

describe("SyncGate hysteresis", () => {
  test("starts open; closes on the FIRST isSyncing poll", async () => {
    const { gate, set } = makeGate();
    expect(gate.gated()).toBe(false);
    set(syncing());
    await gate.check();
    expect(gate.gated()).toBe(true);
  });

  test("one synced poll is not enough to open; two consecutive are", async () => {
    const { gate, set } = makeGate();
    set(syncing());
    await gate.check();
    set(synced());
    await gate.check();
    expect(gate.gated()).toBe(true); // 1 consecutive — still paused
    await gate.check();
    expect(gate.gated()).toBe(false); // 2 consecutive — resumed
  });

  test("a syncing flap resets the consecutive-synced count", async () => {
    const { gate, set } = makeGate();
    set(syncing());
    await gate.check();
    set(synced());
    await gate.check(); // 1
    set(syncing());
    await gate.check(); // reset
    set(synced());
    await gate.check(); // 1 again
    expect(gate.gated()).toBe(true);
    await gate.check(); // 2
    expect(gate.gated()).toBe(false);
  });
});

describe("SyncGate error handling", () => {
  test("poll failure keeps the last state — open stays open, paused stays paused", async () => {
    const { gate, set } = makeGate();
    set(new Error("timeout"));
    await gate.check();
    expect(gate.gated()).toBe(false);

    set(syncing());
    await gate.check();
    set(new Error("timeout"));
    await gate.check();
    await gate.check();
    expect(gate.gated()).toBe(true); // errors never count as synced polls
  });
});

describe("SyncGate signals", () => {
  test("resumed$ and onResume fire exactly once per pause→resume transition", async () => {
    let resumes = 0;
    const { gate, set } = makeGate({ onResume: () => resumes++ });
    const seen: number[] = [];
    gate.resumed$.subscribe(() => seen.push(1));

    set(syncing());
    await gate.check();
    set(synced());
    await gate.check();
    await gate.check(); // opens here
    await gate.check(); // already open — no re-fire
    expect(resumes).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test("publishes gate state and progress to observability as u64 strings", async () => {
    const { gate, observability, set } = makeGate();
    set(syncing(406_173, 512_000));
    await gate.check();
    expect(observability.nodeSyncing).toBe(true);
    expect(observability.nodeSyncCurrentBlock).toBe("406173");
    expect(observability.nodeSyncHighestBlock).toBe("512000");

    set(synced());
    await gate.check();
    expect(observability.nodeSyncing).toBe(true); // hysteresis: still paused
    await gate.check();
    expect(observability.nodeSyncing).toBe(false);
    expect(observability.nodeSyncCurrentBlock).toBeNull();
  });
});
