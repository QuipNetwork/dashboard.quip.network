// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChainHead, ChainMinerRecord } from "../types/telemetry";

/**
 * Network-wide count of winning solutions accepted on chain — the basis for
 * the global "solution / problem number" (count + 1 is the in-flight problem
 * every miner is grinding, quip-protocol MR !105).
 *
 * Prefers the authoritative chain figure `chainHead.winningSolutionsCount`
 * (length of `quantum_pow.WinningSolutions`, read straight from chain by the
 * substrate worker). Falls back to summing per-miner `proofsWon` when
 * chain_head hasn't been observed yet (or a pre-v0.2 chain doesn't expose the
 * count) — every winning solution is one account's won proof, so the sum
 * equals the count whenever `chain_miners` is complete.
 */
export function winningSolutionsSolved(
  chainHead: ChainHead | null,
  chainMiners: Array<Pick<ChainMinerRecord, "proofsWon">>,
): number {
  if (chainHead?.winningSolutionsCount != null) return chainHead.winningSolutionsCount;
  return chainMiners.reduce((sum, m) => sum + Number(m.proofsWon || "0"), 0);
}
