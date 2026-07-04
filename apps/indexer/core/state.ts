// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { IndexerObservability } from "@quip/shared/telemetry";

/**
 * In-memory state shared across indexer workers. v0.3 reduces this to:
 *   - `observability`: the heartbeat snapshot the tip worker flushes
 *     every iteration. Loaded from DB at startup so a restart doesn't
 *     reset chainHeadFromNode / minerStats / etc. to null on the UI.
 *
 * The v5 cursors / etag / stall tracker / chain anchors were owned by
 * tip+backfill REST polling — both gone in v6 (chain is the canonical
 * block source).
 */
export class IndexerState {
  // Latest observed default-topology hash (H256, 0x hex), or null when the
  // chain exposes no default topology / it hasn't been read yet. Written by the
  // chain-state poll and read by the block + difficulty writers so analytics are
  // stamped with the CURRENT default topology — not a value primed once at
  // connect time, which would mis-tag every block after a mid-connection
  // topology change. Transient: re-derived on the next poll after a restart.
  defaultTopologyHash: string | null = null;

  observability: IndexerObservability = {
    chainHeadFromNode: null,
    lastStatusFetchAt: new Date(0).toISOString(),
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    // Transient — never seeded from the DB on restart, since a prior
    // process's WSS connection state is meaningless to a new process.
    chainConnected: false,
    selfIdentified: false,
    minerStats: null,
    // Same transient story as chainConnected — re-fetched on next
    // /api/v1/status poll. Default empty so a fresh process renders
    // "single backend" UI until the first poll lands.
    modes: {},
    // Transient like chainConnected — a prior process's sync-gate state is
    // meaningless to a new process.
    nodeSyncing: false,
    nodeSyncCurrentBlock: null,
    nodeSyncHighestBlock: null,
  };

  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * Seed observability from the DB so the UI doesn't flip to "never
   * indexed" for a few seconds after every deploy. `chainConnected` is
   * intentionally NOT seeded; it's a live WSS state owned by the
   * substrate worker.
   */
  async load(): Promise<void> {
    const prior = await this.db.getIndexerObservability();
    if (prior) {
      this.observability = {
        ...prior,
        chainConnected: false,
        selfIdentified: false,
        nodeSyncing: false,
        nodeSyncCurrentBlock: null,
        nodeSyncHighestBlock: null,
      };
    }
  }
}
