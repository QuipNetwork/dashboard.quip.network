// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L3 contract (spec §4): the pluggable indexable interfaces and the registry.
//
// `BlockContext` lives here — it is part of the plugin contract (plugins
// consume it; `dispatch.ts` imports it to construct the memoized instance).
// Adding an indexable that consumes the existing `BlockContext` reads (or is
// a snapshot poller) is one file in `plugins/` plus one `buildRegistry`
// entry. Adding a block indexable that needs a NEW chain read additionally
// extends `BlockContext` here and its memoized construction in `dispatch.ts`;
// the scheduler and queue are never edited.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type {
  BlockEvents,
  QBlockInfo,
  QBlockParticipant,
  TopologyInfo,
} from "../clients/substrate-client";
import type { IndexerConfig } from "../core/config";
import type { IndexerState } from "../core/state";
import type { ChainClient } from "../substrate/ports";
import { authorshipPlugin } from "./plugins/authorship";
import { babeEpochPlugin } from "./plugins/babe-epoch";
import { chainStatePlugin } from "./plugins/chain-state";
import { difficultyPlugin } from "./plugins/difficulty";
import { difficultyCurrentPlugin } from "./plugins/difficulty-current";
import { minerLocalPlugin } from "./plugins/miner-local";
import { nodeDescriptorsPlugin } from "./plugins/node-descriptors";
import { participationPlugin } from "./plugins/participation";
import { winnersPlugin } from "./plugins/winners";

// Which blocks a block indexable must see: every finalized block (validator
// authorship) or only winner blocks (the sparse qBlocks set — winners,
// difficulty). The scheduler's lane assignment derives from this (spec §5).
export type BlockDomain = "every-block" | "winner-blocks";

// One block's worth of chain data, fetched once by the dispatcher and shared
// by every handler. All reads are memoized: N plugins cost one fetch each.
export interface BlockContext {
  readonly number: number;
  // "tip" = live finalized head; "backfill" = walker/reconciler work. Drives
  // read semantics where they differ (defaultTopologyAt, spec §6).
  readonly source: "tip" | "backfill";
  // Decoded events/extrinsics for the block — one processFinalizedBlock().
  readonly events: BlockEvents;
  readonly qblock: () => Promise<QBlockInfo | null>;
  readonly lastProofBlockAtParent: () => Promise<number>;
  readonly defaultTopologyAt: () => Promise<string | null>;
  /**
   * Current topology node/edge counts, primed once per connection with a
   * `{nodeCount: 0, edgeCount: 0}` fallback — exactly today's `prime()`
   * (`blocks.ts:207-217`). Feeds `blocks.num_nodes` / `num_edges`.
   */
  readonly topology: () => Promise<TopologyInfo>;
  /**
   * The full participant set for this block's qblock, memoized per block.
   * Resolves to `[]` for a non-winner block (no qblock id) or when the chain
   * doesn't expose the participation runtime API. Keyed by the winner event's
   * `qblockId` — the `participation` plugin is its only consumer.
   */
  readonly participants: () => Promise<readonly QBlockParticipant[]>;
}

export interface BlockIndexable {
  // Meta-key suffix (indexer.coverage.<name>) and `--reindex` target.
  readonly name: string;
  readonly kind: "block";
  readonly domain: BlockDomain;
  /** Genesis floor for this indexable (usually 0). Called once per connection. */
  startBlock(client: ChainClient): Promise<number>;
  /** MUST be idempotent: running twice for the same block leaves one row. */
  onBlock(ctx: BlockContext, db: DatabaseAdapter): Promise<void>;
  /** R4: delete this indexable's rows. Coverage/generation are handled by the runner. */
  dropState(db: DatabaseAdapter): Promise<void>;
}

export interface SnapshotIndexable {
  readonly name: string;
  // R9: current-state writer — no history, no coverage, no backfill.
  readonly kind: "snapshot";
  /**
   * Which loop drives poll(). "scheduler" (default) = SnapshotScheduler
   * timer; "tip-worker" = descriptor-only entry driven by the fatal
   * TipWorker (spec §4.1) — the SnapshotScheduler skips it.
   */
  readonly driver?: "scheduler" | "tip-worker";
  intervalSec(cfg: IndexerConfig): number;
  poll(client: ChainClient, db: DatabaseAdapter, state: IndexerState): Promise<void>;
  dropState(db: DatabaseAdapter): Promise<void>;
}

export type Indexable = BlockIndexable | SnapshotIndexable;

export function isBlockIndexable(p: Indexable): p is BlockIndexable {
  return p.kind === "block";
}

export function isSnapshotIndexable(p: Indexable): p is SnapshotIndexable {
  return p.kind === "snapshot";
}

/**
 * The one place indexables are registered (spec §4 registry table). `deps`
 * carries the injected wall-clock so snapshot timestamps stay testable
 * (mirroring `WorkerContext.now`).
 */
export function buildRegistry(
  _cfg: IndexerConfig,
  deps: { now: () => number } = { now: Date.now },
): Indexable[] {
  return [
    winnersPlugin(),
    participationPlugin(),
    difficultyPlugin(),
    authorshipPlugin(),
    chainStatePlugin(),
    babeEpochPlugin(),
    difficultyCurrentPlugin(deps.now),
    nodeDescriptorsPlugin(deps.now),
    minerLocalPlugin(),
  ];
}
