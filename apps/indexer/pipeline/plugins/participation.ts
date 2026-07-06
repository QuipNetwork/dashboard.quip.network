// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `participation` plugin (spec §4 registry): the participant-level counterpart
// to `winners`. For each qblock it records EVERY node that declared it was
// racing (across all device kinds), not just the winner, from the chain's
// `ParticipantsByQBlock` reverse index (ctx.participants → the
// `participants_by_qblock` runtime API). Pure chain facts land in
// `qblock_participation`; the per-type compute/energy aggregate is derived
// downstream so the time model can change without a re-index.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { QBlockParticipationRecord } from "@quip/shared/telemetry";

import type { ChainClient } from "../../substrate/ports";
import type { BlockContext, BlockIndexable } from "../plugin";
import { winnerStartBlock } from "./winners";

export function participationPlugin(): BlockIndexable {
  return {
    name: "participation",
    kind: "block",
    // Participation only exists for qblocks, which are exactly the winner
    // blocks — same sparse lane and start floor as `winners`.
    domain: "winner-blocks",

    startBlock: (client: ChainClient): Promise<number> => winnerStartBlock(client),

    async onBlock(ctx: BlockContext, db: DatabaseAdapter): Promise<void> {
      const winner = ctx.events.winner;
      // No winner → no qblock id to key participation on. (Non-winner blocks
      // never enter the winner-blocks lane, but guard anyway for idempotence.)
      if (winner === null) return;

      const participants = await ctx.participants();
      if (participants.length === 0) return; // upsert of [] is a no-op regardless

      const records: QBlockParticipationRecord[] = participants.map((p) => ({
        qblockId: winner.qblockId,
        account: p.account,
        kind: p.kind,
        budgetSeconds: p.budgetSeconds,
        blockNumber: p.blockNumber,
      }));
      await db.upsertQBlockParticipants(records);
    },

    async dropState(db: DatabaseAdapter): Promise<void> {
      await db.deleteAllQBlockParticipation();
    },
  };
}
