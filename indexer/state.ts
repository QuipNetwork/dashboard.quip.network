// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EpochId, IndexerCursor } from "../src/types/telemetry";
import type { DatabaseAdapter } from "../api/db/adapter";

export interface EtagState {
  nodes: string | null;
}

/**
 * In-memory tracking used by the stall-warning path. Not persisted: if the
 * indexer restarts we just start fresh; operators care about sustained
 * stalls, not ones straddling a deploy.
 */
export interface StallTracker {
  // (epoch, latestBlockIndex) last observed from /api/v1/telemetry/status.
  // null before the first successful poll.
  lastObserved: { epoch: EpochId; blockIndex: number } | null;
  // Wall-clock ms at which lastObserved last changed. Anchors the stall
  // duration calculation so the check is independent of poll cadence.
  lastAdvanceAtMs: number;
  // Wall-clock ms at which we last emitted the stall WARN. Used for
  // rate-limiting so the log doesn't repeat every poll.
  lastWarnAtMs: number;
}

/**
 * ISO timestamp of the most recent insertBlock call. Carried forward across
 * poll iterations (and seeded from the DB at load() time) so a restart with
 * no fresh blocks doesn't make the UI think a block was just inserted.
 */
export interface ObservabilityCache {
  lastBlockInsertAt: string | null;
}

/**
 * In-memory cache of the indexer's cursor and etag state, backed by the
 * DatabaseAdapter. Callers mutate {@link cursor} / {@link etags} and call
 * {@link save} to persist.
 */
export class IndexerState {
  cursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  etags: EtagState = { nodes: null };
  stall: StallTracker = { lastObserved: null, lastAdvanceAtMs: 0, lastWarnAtMs: 0 };
  observability: ObservabilityCache = { lastBlockInsertAt: null };
  // Cache of epoch → block_1.block_hash. Used to test chain membership
  // (epochs sharing a block_1 hash are on the same chain). Not persisted:
  // rebuilding is cheap (one /block fetch per epoch) and the node is the
  // source of truth, so staleness across restarts is fine.
  chainAnchors: Map<EpochId, string> = new Map();

  constructor(private readonly db: DatabaseAdapter) {}

  async load(): Promise<void> {
    this.cursor = await this.db.getCursor();
    this.etags = await this.db.getEtags();
    // Carry forward lastBlockInsertAt across restarts so the UI doesn't
    // flip to "never indexed" for a few seconds after every deploy.
    const prior = await this.db.getIndexerObservability();
    if (prior) this.observability.lastBlockInsertAt = prior.lastBlockInsertAt;
  }

  async save(): Promise<void> {
    await this.db.saveCursor(this.cursor, { nodes: this.etags.nodes });
  }
}
