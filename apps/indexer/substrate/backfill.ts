// SPDX-License-Identifier: AGPL-3.0-or-later

import { EMPTY, type Observable, catchError, concatMap, defer, filter, from } from "rxjs";

import type { BlockEvents } from "../substrate-client";
import { type WorkerContext } from "../core/worker";
import type { BackfillSource } from "./ports";

// Startup backfill as a source of historical winning BlockEvents, run as its own
// pipeline alongside the live subscription. A failed read logs and the source
// completes empty rather than erroring the connection (fire-and-forget).
export class Backfill {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly client: BackfillSource,
  ) {}

  stream(): Observable<BlockEvents> {
    return defer(() => from(this.missing())).pipe(
      concatMap((missing) => from(missing)),
      concatMap((n) => from(this.fetch(n))),
      filter((e): e is BlockEvents => e !== null),
      catchError((err) => {
        console.warn("[indexer/substrate] historical backfill failed:", err);
        return EMPTY;
      }),
    );
  }

  // Winning blocks recorded on-chain but not yet in our `blocks` table. Reads a
  // generous chunk (rolling cap ~500 < chain-lifetime winners); a duplicate read
  // is harmless — insertBlock is INSERT OR IGNORE.
  private async missing(): Promise<string[]> {
    const winning = await this.client.getWinningBlockNumbers();
    if (winning.length === 0) return [];
    const existing = new Set(
      (await this.ctx.db.getRecentBlocks(10_000, 0)).map((b) => b.substrateBlockNumber),
    );
    const missing = winning.filter((n) => !existing.has(n)).sort((a, b) => Number(a) - Number(b));
    if (missing.length > 0) {
      console.log(
        `[indexer/substrate] backfilling ${missing.length} historical winning blocks (of ${winning.length} total)`,
      );
    }
    return missing;
  }

  private async fetch(n: string): Promise<BlockEvents | null> {
    try {
      const events = await this.client.processFinalizedBlock(n);
      if (events === null) {
        console.warn(`[indexer/substrate] backfill: block #${n} not found on chain; skipping`);
      }
      return events;
    } catch (err) {
      console.warn(`[indexer/substrate] backfill: block #${n} failed:`, err);
      return null;
    }
  }
}
