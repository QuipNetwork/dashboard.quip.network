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
 * Cache of indexer observability fields, carried forward across poll
 * iterations and seeded from the DB at load() time so restarts with no
 * fresh writes don't make the UI think a block/event just landed.
 *
 * v5 adds substrate-worker fields. They stay null/false until the substrate
 * worker is configured (QUIP_VALIDATOR_RPC_URL) and starts emitting events.
 * `chainConnected` is transient — it's NOT seeded from the DB on restart
 * (a prior process's connection state is meaningless to a new process).
 */
export interface ObservabilityCache {
  lastBlockInsertAt: string | null;
  lastSubstrateEventAt: string | null;
  bestBlockHeight: string | null;
  finalizedBlockHeight: string | null;
  chainConnected: boolean;
}

/**
 * Pending substrate enrichment from a BlockWinner event that fired before
 * the matching PoW BlockRecord landed via REST. Drained by the tip worker
 * after each successful insertBlock when (minerId, energy) match.
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
 * In-memory cache of the indexer's cursors and etag state, backed by the
 * DatabaseAdapter. Callers mutate {@link tipCursor} / {@link backfillCursor} /
 * {@link etags} and call {@link save} to persist.
 */
export class IndexerState {
  tipCursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  backfillCursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  etags: EtagState = { nodes: null };
  stall: StallTracker = { lastObserved: null, lastAdvanceAtMs: 0, lastWarnAtMs: 0 };
  observability: ObservabilityCache = {
    lastBlockInsertAt: null,
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: false,
  };
  // Cache of epoch → block_1.block_hash. Used to test chain membership
  // (epochs sharing a block_1 hash are on the same chain). Not persisted:
  // rebuilding is cheap (one /block fetch per epoch) and the node is the
  // source of truth, so staleness across restarts is fine.
  chainAnchors: Map<EpochId, string> = new Map();

  // Bounded LRU buffer for BlockWinner events whose matching PoW block
  // hasn't been inserted yet. The tip worker drains after each
  // insertBlock; entries that age out get dropped (no recovery — the
  // dashboard accepts eventual inconsistency on overflow).
  pendingWinnerEvents: Map<WinnerKey, PendingWinnerEvent> = new Map();
  static readonly PENDING_WINNER_LIMIT = 256;

  constructor(private readonly db: DatabaseAdapter) {}

  async load(): Promise<void> {
    const { tip, backfill } = await this.db.getCursors();
    this.tipCursor = tip;
    this.backfillCursor = backfill;
    this.etags = await this.db.getEtags();
    // Carry forward observability across restarts so the UI doesn't flip
    // to "never indexed" for a few seconds after every deploy. chainConnected
    // is intentionally NOT seeded — a prior process's connection state is
    // meaningless to a new process.
    const prior = await this.db.getIndexerObservability();
    if (prior) {
      this.observability.lastBlockInsertAt = prior.lastBlockInsertAt;
      this.observability.lastSubstrateEventAt = prior.lastSubstrateEventAt;
      this.observability.bestBlockHeight = prior.bestBlockHeight;
      this.observability.finalizedBlockHeight = prior.finalizedBlockHeight;
    }
  }

  async save(): Promise<void> {
    await this.db.saveCursors(this.tipCursor, this.backfillCursor, {
      nodes: this.etags.nodes,
    });
  }
}
