// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cadence-driven chain reads: timer(0, period) → exhaustMap(poll). The leading
// 0 fires once on connect; exhaustMap drops a tick rather than overlapping a
// still-running poll; the per-connection cache skips DB writes for unchanged data.

import { type Observable, exhaustMap, merge, timer } from "rxjs";

import type { ConnectionStream, PollSource } from "./ports";
import { type WorkerContext, nowIso } from "./shared";
import { runEffect } from "./streams";

interface PollCache {
  babeEpoch: string | null;
  difficulty: string | null;
  chainMiners: string | null;
  babeAuthorities: string | null;
}

export class PollScheduler implements ConnectionStream {
  private readonly cache: PollCache = {
    babeEpoch: null,
    difficulty: null,
    chainMiners: null,
    babeAuthorities: null,
  };

  constructor(
    private readonly ctx: WorkerContext,
    private readonly client: PollSource,
  ) {}

  stream(): Observable<never> {
    const babeMs = this.ctx.config.substrateBabePollSec * 1000;
    const chainMs = this.ctx.config.substrateChainPollSec * 1000;

    return merge(
      timer(0, babeMs).pipe(exhaustMap(() => runEffect("babe-epoch poll", () => this.pollBabeEpoch()))),
      timer(0, chainMs).pipe(
        exhaustMap(() => runEffect("difficulty poll", () => this.pollDifficulty())),
      ),
      timer(0, chainMs).pipe(
        exhaustMap(() => runEffect("chain-state poll", () => this.pollChainState())),
      ),
    );
  }

  private async pollBabeEpoch(): Promise<void> {
    const info = await this.client.getBabeEpoch();
    if (!info) return;
    const hash = `${info.epochIndex}:${info.currentSlot}`;
    if (hash === this.cache.babeEpoch) return;
    this.cache.babeEpoch = hash;

    // Modulo, not (currentSlot − epochStartSlot): BABE slots are absolute
    // (include genesisSlot), so modulo gives the correct in-epoch offset.
    let currentSlotInEpoch = 0;
    try {
      currentSlotInEpoch = Number(BigInt(info.currentSlot) % BigInt(info.slotsPerEpoch));
    } catch {
      // Malformed slot values — leave at 0 rather than throw.
    }

    await this.ctx.db.upsertBabeEpoch({
      epochIndex: info.epochIndex,
      currentSlot: info.currentSlot,
      epochStartSlot: info.epochStartSlot,
      slotsPerEpoch: info.slotsPerEpoch,
      currentSlotInEpoch,
      authorityCount: info.authorityCount,
    });
  }

  private async pollDifficulty(): Promise<void> {
    const info = await this.client.getDifficulty();
    if (!info) return;
    const observedAtBlock = this.ctx.state.observability.finalizedBlockHeight;
    if (observedAtBlock === null) return;
    // milli → float: the chain stores milli-encodings to keep consensus integer-only.
    const difficultyEnergy = info.maxEnergyMilli / 1000;
    const minDiversity = info.minDiversityMilli / 1000;
    const hash = `${difficultyEnergy}:${minDiversity}:${info.minSolutions}`;
    if (hash === this.cache.difficulty) return;
    this.cache.difficulty = hash;

    await this.ctx.db.insertDifficultySnapshot({
      observedAtBlock,
      difficultyEnergy,
      minDiversity,
      minSolutions: info.minSolutions,
      observedAt: nowIso(this.ctx),
    });
  }

  private async pollChainState(): Promise<void> {
    const [miners, authorities, epoch] = await Promise.all([
      this.client.getChainMiners(),
      this.client.getBabeAuthorities(),
      this.client.getBabeEpoch(),
    ]);

    const sortedMiners = [...miners].sort((a, b) =>
      a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
    );
    const minersHash = sortedMiners
      .map(
        (m) => `${m.accountId}:${m.deposit}:${m.proofsSubmitted}:${m.proofsWon}:${m.rewardsEarned}`,
      )
      .join("|");
    if (minersHash !== this.cache.chainMiners) {
      this.cache.chainMiners = minersHash;
      await this.ctx.db.upsertChainMiners(
        sortedMiners.map((m) => ({
          accountId: m.accountId,
          deposit: m.deposit,
          proofsSubmitted: m.proofsSubmitted,
          proofsWon: m.proofsWon,
          rewardsEarned: m.rewardsEarned,
        })),
      );
    }

    // Authorities key on the current epoch; if the BABE poll hasn't landed yet
    // they defer to the next tick. Miners key on account ID, so write always.
    if (epoch) {
      const sortedAuthorities = [...authorities].sort((a, b) =>
        a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
      );
      const authoritiesHash = `${epoch.epochIndex}|${sortedAuthorities.map((a) => a.accountId).join(",")}`;
      if (authoritiesHash !== this.cache.babeAuthorities) {
        this.cache.babeAuthorities = authoritiesHash;
        await this.ctx.db.upsertBabeAuthorities(epoch.epochIndex, sortedAuthorities);
      }
    }
  }
}
