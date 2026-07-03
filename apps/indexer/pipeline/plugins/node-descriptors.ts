// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `node-descriptors` snapshot: finalized-head registry snapshots. The scan
// body is `descriptor/iteration.ts` (kept as the logic module it already
// is); this plugin is the scheduling shell that replaces
// `descriptor/worker.ts`'s dedicated connection loop. Keeps the existing
// monotonic DESCRIPTOR_CHECKPOINT_KEY via `db.setDescriptorCheckpoint`.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { runDescriptorIteration } from "../../descriptor/iteration";
import type { IndexerState } from "../../core/state";
import type { ChainClient } from "../../substrate/ports";
import type { SnapshotIndexable } from "../plugin";

// The old descriptor worker scanned every 2s (descriptor/worker.ts default
// scanIntervalMs 2000) — one snapshot per finalized head at 6s slots.
const SCAN_INTERVAL_SEC = 2;

export function nodeDescriptorsPlugin(now: () => number): SnapshotIndexable {
  // Skip re-scanning a head we already processed this process lifetime; the
  // upserts are idempotent so a redundant scan is harmless, just wasteful.
  let lastScanned: string | null = null;

  return {
    name: "node-descriptors",
    kind: "snapshot",

    intervalSec: () => SCAN_INTERVAL_SEC,

    async poll(client: ChainClient, db: DatabaseAdapter, state: IndexerState): Promise<void> {
      const head = state.observability.finalizedBlockHeight;
      // Idle until the substrate stream lands the first finalized head —
      // same guard as descriptor/worker.ts:172.
      if (head === null || head === lastScanned) return;
      const ok = await runDescriptorIteration({ client, db, now }, head);
      if (ok) lastScanned = head;
    },

    async dropState(): Promise<void> {
      // Current-state snapshot: the next scan fully re-upserts the registry
      // at the finalized head (spec §8). The monotonic checkpoint stays —
      // it records scan progress, not derived rows.
    },
  };
}
