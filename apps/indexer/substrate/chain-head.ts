// SPDX-License-Identifier: AGPL-3.0-or-later
//
// chain_head: merge(new, finalized) → scan latest pair → debounce → write.
// Per-head observability updates fire immediately; the row write coalesces a
// flurry of heads into one and computes the finality lag.

import { type Observable, concatMap, debounceTime, map, merge, scan, tap } from "rxjs";

import { runEffect } from "../core/rx";
import type { SubstrateHead } from "../substrate-client";
import { type WorkerContext, nowIso } from "../core/worker";
import type { ConnectionStream, HeadSource } from "./ports";
import { fromChainSubscription } from "./streams";

type HeadKind = "best" | "finalized";
type HeadEvent = { kind: HeadKind; head: SubstrateHead };
interface HeadState {
  best: SubstrateHead | null;
  finalized: SubstrateHead | null;
}

export class ChainHeadWriter implements ConnectionStream {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly debounceMs: number,
    private readonly client: HeadSource,
  ) {}

  stream(): Observable<never> {
    const newHeads$ = fromChainSubscription<SubstrateHead>((cb) =>
      this.client.subscribeNewHeads(cb),
    ).pipe(
      tap(() => {
        this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
      }),
      map((head): HeadEvent => ({ kind: "best", head })),
    );
    const finalizedHeads$ = fromChainSubscription<SubstrateHead>((cb) =>
      this.client.subscribeFinalizedHeads(cb),
    ).pipe(
      tap((head) => {
        this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
        this.ctx.state.observability.finalizedBlockHeight = head.number;
      }),
      map((head): HeadEvent => ({ kind: "finalized", head })),
    );

    return merge(newHeads$, finalizedHeads$).pipe(
      scan<HeadEvent, HeadState>(
        (acc, ev) =>
          ev.kind === "best" ? { ...acc, best: ev.head } : { ...acc, finalized: ev.head },
        { best: null, finalized: null },
      ),
      debounceTime(this.debounceMs),
      concatMap((heads) => runEffect("chain_head write", () => this.write(heads))),
    );
  }

  /**
   * Substrate guarantees finalized ≤ best, so when only one head is known we
   * fill the other with it: a fresh subscription that hasn't seen the other
   * event yet still produces a valid row, and later events refine the lag.
   */
  private async write(heads: HeadState): Promise<void> {
    const { db, state } = this.ctx;
    const client = this.client;
    const known = heads.best ?? heads.finalized;
    if (!known) return;
    const best = heads.best ?? known;
    const finalized = heads.finalized ?? known;

    const rt = await client.getRuntimeVersion().catch((e) => {
      console.warn(
        "[indexer/substrate] runtime version fetch failed; skipping chain_head write:",
        e instanceof Error ? e.message : e,
      );
      return null;
    });
    if (!rt) return;
    const lastUpgrade = await client.getLastRuntimeUpgrade().catch(() => null);
    // The global solution_number bound; best-effort, null leaves the
    // mining-attempts catch-up to skip a tick.
    const winningSolutionsCount = await client.getWinningSolutionsCount().catch(() => null);
    const bestN = best.number;
    const finN = finalized.number;
    const lag = (() => {
      try {
        return Number(BigInt(bestN) - BigInt(finN));
      } catch {
        return 0;
      }
    })();

    await db.upsertChainHead({
      bestBlockNumber: bestN,
      bestBlockHash: best.hash,
      finalizedBlockNumber: finN,
      finalizedBlockHash: finalized.hash,
      finalityLag: lag,
      winningSolutionsCount,
      runtime: {
        specName: rt.specName,
        specVersion: rt.specVersion,
        transactionVersion: rt.transactionVersion,
        implName: rt.implName,
        lastRuntimeUpgrade: lastUpgrade?.blockNumber ?? null,
      },
      updatedAt: nowIso(this.ctx),
    });
    state.observability.bestBlockHeight = bestN;
    state.observability.finalizedBlockHeight = finN;
  }
}
