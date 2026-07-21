// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `authorship` plugin (spec §9): row-per-(validator, block) facts for every
// finalized block — the every-block domain that drives the dense walk. The
// old path's per-connection BoundedKeySet dedup is gone: the insert itself is
// idempotent now, so replays (crash, reconnect, reconciler re-visit) are
// row-level no-ops instead of double counts.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { BlockContext, BlockIndexable } from "../plugin";

export function authorshipPlugin(): BlockIndexable {
  return {
    name: "authorship",
    kind: "block",
    domain: "every-block",

    // This runtime has no per-validator authored-block counter (no imOnline /
    // staking / authorship pallet), so counts can only be reconstructed by
    // walking each block's author digest. Rather than pay the whole-chain
    // [0, head] dense walk — the single biggest source of backfill load on the
    // validator — to seed lifetime totals, start at the current head and let
    // tip-following accumulate counts from now on. The validator SET is read
    // directly from `session.validators`; only these counters are
    // indexer-relative. On restart, persisted coverage is reused (ensureLoaded
    // discards this value), so restarts backfill only the bounded downtime gap
    // above the last covered head — never genesis.
    startBlock: async (client) => Number(await client.getFinalizedHead()),

    async onBlock(ctx: BlockContext, db: DatabaseAdapter): Promise<void> {
      const e = ctx.events;
      // `author` is null only when BABE digest derivation failed — nothing
      // to record, same as the old path (blocks.ts:222-223).
      if (e.author === null) return;
      await db.recordValidatorAuthorship(
        e.author,
        String(e.blockNumber),
        e.timestamp,
        e.winner !== null,
      );
    },

    async dropState(db: DatabaseAdapter): Promise<void> {
      // Rows + cutover flag: reads fall back to the §9.2 union (the summary
      // table keeps its last values as the frozen side), so values never
      // regress during the re-walk; cutover re-fires when the new table
      // catches back up.
      await db.resetAuthorshipHistory();
    },
  };
}
