// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `difficulty-current` snapshot: body moved from `substrate/polls.ts`
// pollDifficulty. Live post-retarget difficulty at the finalized head,
// written on value change only — the intra-win-visible series that the
// winner-derived `difficulty` block plugin cannot capture (spec §10.3).

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { IndexerConfig } from "../../core/config";
import type { IndexerState } from "../../core/state";
import type { ChainClient } from "../../substrate/ports";
import type { SnapshotIndexable } from "../plugin";

export function difficultyCurrentPlugin(now: () => number): SnapshotIndexable {
  let cache: string | null = null;

  return {
    name: "difficulty-current",
    kind: "snapshot",

    intervalSec: (cfg: IndexerConfig) => cfg.substrateChainPollSec,

    async poll(client: ChainClient, db: DatabaseAdapter, state: IndexerState): Promise<void> {
      const info = await client.getDifficulty();
      if (!info) return;
      const observedAtBlock = state.observability.finalizedBlockHeight;
      if (observedAtBlock === null) return;
      // milli → float: the chain stores milli-encodings to keep consensus
      // integer-only.
      const difficultyEnergy = info.maxEnergyMilli / 1000;
      const minDiversity = info.minDiversityMilli / 1000;
      // Fold the topology into the dedup key so a topology change forces a
      // fresh snapshot even when the values are momentarily unchanged.
      const topologyHash = state.defaultTopologyHash;
      const hash = `${difficultyEnergy}:${minDiversity}:${info.minSolutions}:${topologyHash ?? ""}`;
      if (hash === cache) return;
      cache = hash;

      await db.insertDifficultySnapshot({
        observedAtBlock,
        difficultyEnergy,
        minDiversity,
        minSolutions: info.minSolutions,
        observedAt: new Date(now()).toISOString(),
        topologyHash,
        // Never overwrites a winner-derived 'block' row (spec §9.3).
        source: "poll",
      });
    },

    async dropState(): Promise<void> {
      // Documented no-op (spec §8): poll rows stamp arbitrary head heights
      // with wall-clock times — not re-derivable, and the next poll writes
      // forward regardless, so deletion serves no reindex purpose.
    },
  };
}
