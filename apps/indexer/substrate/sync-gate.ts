// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SyncGate (design 2026-07-04): poll system_health/system_syncState and gate
// heavy pipeline work while the connected validator is in major sync — its
// I/O is saturated importing blocks, and backfill dispatch / reconciler
// cross-checks / snapshot scans stall its synchronization. The gate closes
// (pauses) on the FIRST isSyncing=true poll and opens only after
// SYNCED_CONSECUTIVE_POLLS consecutive isSyncing=false polls, because nodes
// flap the flag near the tip. Poll failures keep the last state — never
// pause a healthy pipeline because one health poll timed out.

import { Subject, defer, ignoreElements, repeat, timer, type Observable } from "rxjs";

import type { SyncStateInfo } from "../clients/substrate-client";
import type { IndexerState } from "../core/state";
import type { ConnectionStream, SyncSource } from "./ports";

export const SYNCING_POLL_MS = 5_000;
export const SYNCED_POLL_MS = 30_000;
const SYNCED_CONSECUTIVE_POLLS = 2;
const FAILURES_BEFORE_WARN = 3;

export interface SyncGateDeps {
  client: SyncSource;
  state: Pick<IndexerState, "observability">;
  syncingPollMs?: number;
  syncedPollMs?: number;
  // Wakes the dispatcher the instant the gate opens (worker wires the
  // queue's wake fn) so drained tip items don't wait a retry interval.
  onResume?: () => void;
}

export class SyncGate implements ConnectionStream {
  /** Fires when the gate opens after a pause (reconciler re-tick). */
  readonly resumed$ = new Subject<void>();

  private isGated = false;
  private consecutiveSynced = 0;
  private failures = 0;

  constructor(private readonly deps: SyncGateDeps) {}

  /** True while heavy work (backfill, reconcile, snapshots) must pause. */
  gated(): boolean {
    return this.isGated;
  }

  stream(): Observable<never> {
    // check → sleep (5s while gated, 30s once synced) → repeat. The worker
    // runs the priming check() before the pipeline subscribes, so the
    // leading check here is a cheap refresh, not the startup detection.
    return defer(() => this.check()).pipe(
      repeat({
        delay: () =>
          timer(
            this.isGated
              ? (this.deps.syncingPollMs ?? SYNCING_POLL_MS)
              : (this.deps.syncedPollMs ?? SYNCED_POLL_MS),
          ),
      }),
      ignoreElements(),
    ) as Observable<never>;
  }

  /** One poll. Public for tests and for the worker's startup prime. */
  async check(): Promise<void> {
    let s: SyncStateInfo;
    try {
      s = await this.deps.client.getSyncState();
    } catch (err) {
      this.failures += 1;
      if (this.failures === FAILURES_BEFORE_WARN) {
        console.warn(
          `[indexer/substrate] sync-state poll failed ${this.failures}x; ` +
            `keeping gate ${this.isGated ? "paused" : "open"}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return; // failure ≠ syncing — keep the last state
    }
    this.failures = 0;

    if (s.isSyncing) {
      this.consecutiveSynced = 0;
      if (!this.isGated) {
        this.isGated = true;
        console.warn(`[indexer/substrate] validator is syncing${progress(s)} — pausing indexing`);
      }
    } else if (this.isGated) {
      this.consecutiveSynced += 1;
      if (this.consecutiveSynced >= SYNCED_CONSECUTIVE_POLLS) {
        this.isGated = false;
        console.warn(`[indexer/substrate] validator synced${progress(s)} — resuming indexing`);
        this.resumed$.next();
        this.deps.onResume?.();
      }
    }
    this.publish(s);
  }

  private publish(s: SyncStateInfo): void {
    const obs = this.deps.state.observability;
    // Publish the GATE state, not the raw flag — the UI inherits the
    // hysteresis so it doesn't flap near the tip.
    obs.nodeSyncing = this.isGated;
    obs.nodeSyncCurrentBlock = s.currentBlock === null ? null : String(s.currentBlock);
    obs.nodeSyncHighestBlock = s.highestBlock === null ? null : String(s.highestBlock);
  }
}

function progress(s: SyncStateInfo): string {
  if (s.currentBlock === null || s.highestBlock === null) return "";
  return ` (${s.currentBlock.toLocaleString("en-US")}/${s.highestBlock.toLocaleString("en-US")})`;
}
