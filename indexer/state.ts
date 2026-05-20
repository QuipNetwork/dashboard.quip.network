// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import type { IndexerObservability } from "../src/types/telemetry";

/**
 * Pending substrate enrichment from a BlockWinner event that fired before
 * the matching PoW BlockRecord landed in the DB. The substrate worker
 * buffers these in `pendingWinnerEvents`; the canonical block writer
 * drains them after insertBlock when (minerId, energy) match.
 *
 * Slated for removal in Task 2.3 once the substrate worker becomes the
 * sole canonical block writer (no more two-phase enrichment race).
 */
export interface PendingWinnerEvent {
  miner: string;
  energy: number;
  submittedAt: string;
  // Substrate header looked up at event time. Cached so the drain path
  // doesn't re-fetch.
  substrateBlockHash: string;
  substrateParentHash: string;
  extrinsicsRoot: string;
  stateRoot: string;
}

/** Key for the pendingWinnerEvents map: `${minerId}:${energy}`. */
export type WinnerKey = `${string}:${number}`;

/**
 * In-memory state shared across indexer workers. v0.3 reduces this to:
 *   - `observability`: the heartbeat snapshot the tip worker flushes
 *     every iteration. Loaded from DB at startup so a restart doesn't
 *     reset chainHeadFromNode / minerStats / etc. to null on the UI.
 *   - `pendingWinnerEvents`: bounded LRU for BlockWinner events whose
 *     matching PoW block hasn't been inserted yet. Slated for removal
 *     in Task 2.3.
 *
 * The v5 cursors / etag / stall tracker / chain anchors were owned by
 * tip+backfill REST polling — both gone in v6 (chain is the canonical
 * block source).
 */
export class IndexerState {
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
    minerStats: null,
  };

  // Bounded LRU buffer for BlockWinner events whose matching PoW block
  // hasn't been inserted yet. Drained by the canonical block writer
  // after insertBlock; entries that age out get dropped (no recovery —
  // the dashboard accepts eventual inconsistency on overflow).
  pendingWinnerEvents: Map<WinnerKey, PendingWinnerEvent> = new Map();
  static readonly PENDING_WINNER_LIMIT = 256;

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
      this.observability = { ...prior, chainConnected: false };
    }
  }
}
