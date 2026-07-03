// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `babe-epoch` snapshot: body moved from `substrate/polls.ts` pollBabeEpoch.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { IndexerConfig } from "../../core/config";
import type { ChainClient } from "../../substrate/ports";
import type { SnapshotIndexable } from "../plugin";

export function babeEpochPlugin(): SnapshotIndexable {
  let cache: string | null = null;

  return {
    name: "babe-epoch",
    kind: "snapshot",

    intervalSec: (cfg: IndexerConfig) => cfg.substrateBabePollSec,

    async poll(client: ChainClient, db: DatabaseAdapter): Promise<void> {
      const info = await client.getBabeEpoch();
      if (!info) return;
      const hash = `${info.epochIndex}:${info.currentSlot}`;
      if (hash === cache) return;
      cache = hash;

      // Modulo, not (currentSlot − epochStartSlot): BABE slots are absolute
      // (include genesisSlot), so modulo gives the correct in-epoch offset.
      let currentSlotInEpoch = 0;
      try {
        currentSlotInEpoch = Number(BigInt(info.currentSlot) % BigInt(info.slotsPerEpoch));
      } catch {
        // Malformed slot values — leave at 0 rather than throw.
      }

      await db.upsertBabeEpoch({
        epochIndex: info.epochIndex,
        currentSlot: info.currentSlot,
        epochStartSlot: info.epochStartSlot,
        slotsPerEpoch: info.slotsPerEpoch,
        currentSlotInEpoch,
        authorityCount: info.authorityCount,
      });
    },

    async dropState(): Promise<void> {
      // Current-state snapshot: the next poll fully overwrites (spec §8).
    },
  };
}
