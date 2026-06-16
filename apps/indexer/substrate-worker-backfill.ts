// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlockEvents } from "./substrate-client";
import type { ConnectedDeps } from "./substrate-worker-shared";

/**
 * Walk `quantum_pow.WinningSolutions` storage to find historical winning
 * blocks that aren't in our local `blocks` table yet, then fetch and write
 * each through the same path the live subscription uses.
 *
 * Called once on every successful connect. With INSERT OR IGNORE
 * idempotency on `blocks.block_hash`, repeated runs over already-backfilled
 * blocks are no-ops; the work is bounded by the number of unique winning
 * blocks the chain has ever emitted, which is small (≤ chain height).
 */
export async function backfillHistoricalWins(
  deps: ConnectedDeps,
  write: (e: BlockEvents) => Promise<void>,
): Promise<void> {
  const { client, db } = deps;
  const winning = await client.getWinningBlockNumbers();
  if (winning.length === 0) return;

  // Snapshot existing block numbers in one go. The store's rolling cap is
  // ~500 rows; chain-lifetime winners can exceed that, so we read a
  // generous chunk to avoid backfilling blocks we already have. Anything
  // beyond the chunk that's a duplicate is harmless — INSERT OR IGNORE.
  const existingNums = new Set(
    (await db.getRecentBlocks(10_000, 0)).map((b) => b.substrateBlockNumber),
  );
  const missing = winning.filter((n) => !existingNums.has(n)).sort((a, b) => Number(a) - Number(b));
  if (missing.length === 0) return;

  console.log(
    `[indexer/substrate] backfilling ${missing.length} historical winning blocks (of ${winning.length} total)`,
  );

  // Sequential walk to keep RPC pressure low. Each block requires a
  // getBlockHash + derive.chain.getBlock + timestamp.now.at + 1 runtime
  // API call — ~4 RPCs per missing block. A chain with 1000 historical
  // wins backfills in seconds.
  for (const n of missing) {
    try {
      const events = await client.processFinalizedBlock(n);
      if (events === null) {
        console.warn(`[indexer/substrate] backfill: block #${n} not found on chain; skipping`);
        continue;
      }
      await write(events);
    } catch (err) {
      console.warn(`[indexer/substrate] backfill: block #${n} failed:`, err);
    }
  }
}
