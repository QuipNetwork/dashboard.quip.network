// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `chain-state` snapshot (spec §4 registry): miners + BABE authorities +
// mineable topologies. Body moved from `substrate/polls.ts` pollChainState +
// upsertMineableTopologies. MUST keep publishing `state.defaultTopologyHash`
// every poll — the dispatcher's tip-source `defaultTopologyAt()` fallback
// depends on it (spec §6), and it must track mid-connection topology
// switches, not a connect-time prime.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { MineableTopologyRecord } from "@quip/shared/telemetry";

import type { MineableTopologyInfo } from "../../clients/substrate-client";
import type { IndexerConfig } from "../../core/config";
import type { IndexerState } from "../../core/state";
import type { ChainClient } from "../../substrate/ports";
import type { SnapshotIndexable } from "../plugin";

export function chainStatePlugin(): SnapshotIndexable {
  // Change-dedup caches so unchanged polls don't re-write rows. Instance
  // state: values are chain-global, so surviving a reconnect is correct.
  let minersCache: string | null = null;
  let authoritiesCache: string | null = null;
  let topologiesCache: string | null = null;

  async function upsertMineableTopologies(
    db: DatabaseAdapter,
    state: IndexerState,
    topologies: MineableTopologyInfo[],
  ): Promise<void> {
    const records: MineableTopologyRecord[] = topologies.map((t) => ({
      topologyHash: t.topologyHash,
      isDefault: t.isDefault,
      difficultyEnergy: t.difficulty.maxEnergyMilli / 1000,
      minDiversity: t.difficulty.minDiversityMilli / 1000,
      minSolutions: t.difficulty.minSolutions,
      nodeCount: t.nodeCount,
      edgeCount: t.edgeCount,
      curveConstant: t.curveConstant,
    }));
    // Publish every poll, independent of the change-dedup below.
    state.defaultTopologyHash = records.find((r) => r.isDefault)?.topologyHash ?? null;
    const sorted = [...records].sort((a, b) =>
      a.topologyHash < b.topologyHash ? -1 : a.topologyHash > b.topologyHash ? 1 : 0,
    );
    const hash = sorted
      .map(
        (t) =>
          `${t.topologyHash}:${t.isDefault}:${t.difficultyEnergy}:${t.minDiversity}:${t.minSolutions}:${t.nodeCount}:${t.edgeCount}:${t.curveConstant}`,
      )
      .join("|");
    if (hash === topologiesCache) return;
    topologiesCache = hash;
    await db.setMineableTopologies(sorted);
  }

  return {
    name: "chain-state",
    kind: "snapshot",

    intervalSec: (cfg: IndexerConfig) => cfg.substrateChainPollSec,

    async poll(client: ChainClient, db: DatabaseAdapter, state: IndexerState): Promise<void> {
      const [miners, authorities, epoch, mineableTopologies] = await Promise.all([
        client.getChainMiners(),
        client.getBabeAuthorities(),
        client.getBabeEpoch(),
        client.getMineableTopologies(),
      ]);

      const sortedMiners = [...miners].sort((a, b) =>
        a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
      );
      const minersHash = sortedMiners
        .map(
          (m) =>
            `${m.accountId}:${m.deposit}:${m.proofsSubmitted}:${m.proofsWon}:${m.rewardsEarned}`,
        )
        .join("|");
      if (minersHash !== minersCache) {
        minersCache = minersHash;
        await db.upsertChainMiners(
          sortedMiners.map((m) => ({
            accountId: m.accountId,
            deposit: m.deposit,
            proofsSubmitted: m.proofsSubmitted,
            proofsWon: m.proofsWon,
            rewardsEarned: m.rewardsEarned,
          })),
        );
      }

      // Authorities key on the current epoch; if the BABE poll hasn't landed
      // yet they defer to the next tick.
      if (epoch) {
        const sortedAuthorities = [...authorities].sort((a, b) =>
          a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
        );
        const authoritiesHash = `${epoch.epochIndex}|${sortedAuthorities.map((a) => a.accountId).join(",")}`;
        if (authoritiesHash !== authoritiesCache) {
          authoritiesCache = authoritiesHash;
          await db.upsertBabeAuthorities(epoch.epochIndex, sortedAuthorities);
        }
      }

      await upsertMineableTopologies(db, state, mineableTopologies);
    },

    async dropState(): Promise<void> {
      // Current-state snapshot: the next poll fully overwrites; nothing to
      // rebuild, nothing worth deleting (spec §8).
    },
  };
}
