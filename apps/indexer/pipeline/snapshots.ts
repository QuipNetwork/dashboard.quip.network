// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SnapshotScheduler (spec §4/§5): generalizes the old PollScheduler — one
// `timer(0, intervalSec) → exhaustMap(runEffect(poll))` per registered
// snapshot plugin. The leading 0 fires on connect; exhaustMap drops a tick
// rather than overlapping a still-running poll. Entries with
// `driver: "tip-worker"` are skipped — the fatal TipWorker drives those
// (spec §4.1). Under --once each plugin runs its leading poll exactly once.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { EMPTY, exhaustMap, filter, merge, take, timer, type Observable } from "rxjs";

import type { IndexerConfig } from "../core/config";
import { runEffect } from "../core/rx";
import type { IndexerState } from "../core/state";
import type { ChainClient, ConnectionStream } from "../substrate/ports";
import type { SnapshotIndexable } from "./plugin";

export interface SnapshotSchedulerDeps {
  client: ChainClient;
  db: DatabaseAdapter;
  state: IndexerState;
  config: IndexerConfig;
  snapshots: SnapshotIndexable[];
  once?: boolean;
  // Sync gate (design 2026-07-04): gated ticks are filtered out BEFORE
  // --once's take(1) so once-mode still runs its single poll after the
  // node syncs; resume$ re-polls promptly instead of waiting a full
  // interval.
  gated?: () => boolean;
  resume$?: Observable<void>;
}

export class SnapshotScheduler implements ConnectionStream {
  constructor(private readonly deps: SnapshotSchedulerDeps) {}

  stream(): Observable<never> {
    const { client, db, state, config, snapshots, once, gated, resume$ } = this.deps;
    const streams = snapshots
      .filter((p) => (p.driver ?? "scheduler") === "scheduler")
      .map((p) => {
        const base$ = timer(0, p.intervalSec(config) * 1000);
        const tick$ = (resume$ ? merge(base$, resume$) : base$).pipe(filter(() => !gated?.()));
        return (once ? tick$.pipe(take(1)) : tick$).pipe(
          exhaustMap(() => runEffect(`${p.name} poll`, () => p.poll(client, db, state))),
        );
      });
    return streams.length > 0 ? (merge(...streams) as Observable<never>) : EMPTY;
  }
}
