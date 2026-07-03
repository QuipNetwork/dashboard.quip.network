// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `difficulty` plugin (spec §10): deep difficulty history derived from winner
// blocks. Each winner's qblock carries the MINED-AGAINST difficulty (the
// threshold that win actually cleared), recorded at the win block with the
// block's own timestamp — so backfilled rows sort correctly among live poll
// snapshots. Pre-v0.2 winners carry no qblock difficulty and are skipped
// (decided policy, spec §10.2): no order-dependent prior-row fallback.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { BlockContext, BlockIndexable } from "../plugin";
import { winnerStartBlock } from "./winners";

export function difficultyPlugin(): BlockIndexable {
  return {
    name: "difficulty",
    kind: "block",
    domain: "winner-blocks",

    startBlock: winnerStartBlock,

    async onBlock(ctx: BlockContext, db: DatabaseAdapter): Promise<void> {
      const e = ctx.events;
      if (e.winner === null) return;
      const qblock = await ctx.qblock();
      if (!qblock?.difficulty) return; // pre-v0.2 era — decided skip

      await db.insertDifficultySnapshot({
        observedAtBlock: String(e.blockNumber),
        difficultyEnergy: qblock.difficulty.maxEnergyMilli / 1000,
        minDiversity: qblock.difficulty.minDiversityMilli / 1000,
        minSolutions: qblock.difficulty.minSolutions,
        // The block's timestamp inherent, not wall-clock: backfilled rows
        // must interleave correctly with live poll rows on observed_at.
        observedAt: new Date(e.timestamp * 1000).toISOString(),
        topologyHash: await ctx.defaultTopologyAt(),
        // Block-wins precedence at the same key is the adapter's job
        // (spec §9.3).
        source: "block",
      });
    },

    async dropState(db: DatabaseAdapter): Promise<void> {
      // Only this writer's rows: poll snapshots (including the pre-v0.2
      // era's only difficulty data) are not re-derivable and never dropped.
      await db.deleteDifficultyHistoryBySource("block");
    },
  };
}
