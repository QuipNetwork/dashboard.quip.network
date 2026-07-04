// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChainHead } from "@quip/shared/telemetry";

/**
 * Blocks per difficulty-decay step — quip-protocol-rs
 * `QuantumPowEpochLength = 100` on spec 101 (pallets/quantum-pow/src/
 * difficulty.rs:261). Pipe through telemetry if/when the constant ever
 * varies per chain.
 */
export const QUANTUM_POW_EPOCH_LENGTH = 100;

type HeadNumbers = Pick<ChainHead, "bestBlockNumber" | "finalizedBlockNumber">;

/**
 * Substrate blocks elapsed since the last winning proof, at the BEST head.
 *
 * The runtime's `apply_decay` moves with the executing chain, not with
 * finality. Anchoring on `finalizedBlockNumber` (the previous behavior in
 * three components) undercounts whenever finality lags — during the
 * 2026-07-04 validator outage finality stalled entirely and the dashboard
 * showed "Decays Applied: 0" while the live target had already decayed
 * several steps, making the displayed Target Energy look already met.
 * Falls back to the finalized number when a best number is absent.
 */
export function blocksSinceLastProof(
  chainHead: HeadNumbers | null,
  lastProofBlockNumber: number | string | null,
): number | null {
  if (chainHead == null || lastProofBlockNumber == null) return null;
  const headRaw = chainHead.bestBlockNumber || chainHead.finalizedBlockNumber;
  if (!headRaw) return null;
  const head = Number(headRaw);
  const anchor = Number(lastProofBlockNumber);
  if (!Number.isFinite(head) || !Number.isFinite(anchor)) return null;
  return Math.max(0, head - anchor);
}

/**
 * Difficulty-decay steps applied since the last winning proof: one step per
 * `QUANTUM_POW_EPOCH_LENGTH` blocks past `LastProofBlock`, mirroring the
 * runtime's `apply_decay` (see `blocksSinceLastProof` for the head choice).
 */
export function decaysApplied(
  chainHead: HeadNumbers | null,
  lastProofBlockNumber: number | string | null,
): number | null {
  const blocks = blocksSinceLastProof(chainHead, lastProofBlockNumber);
  return blocks != null ? Math.floor(blocks / QUANTUM_POW_EPOCH_LENGTH) : null;
}
