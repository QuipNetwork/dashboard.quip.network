// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlockRecord } from "@/types/telemetry";

interface FinalityBadgeProps {
  block: BlockRecord;
}

/**
 * Compact chip indicating whether the substrate chain has finalized this
 * PoW block. Two render states:
 *
 *   - Pending: finalized=false. Yellow chip; the chain has produced this
 *     block but Grandpa hasn't finalized it yet.
 *   - Finalized: green chip. Finalization is monotonic; once shown, the
 *     chain has committed.
 *
 * v0.3 substrate-canonical model: every BlockRecord has a non-null
 * substrate block number by construction, so there is no "not joined"
 * intermediate state.
 */
export function FinalityBadge({ block }: FinalityBadgeProps) {
  if (block.finalized) {
    return (
      <span
        className="inline-flex items-center gap-1 border border-positive/40 bg-positive/10 px-1.5 py-0.5 font-accent text-[10px] text-positive"
        title={`Finalized at substrate block ${block.substrateBlockNumber}`}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-positive" aria-hidden />
        finalized
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-accent text-[10px] text-warning"
      title={`Substrate block ${block.substrateBlockNumber} awaiting Grandpa finalization`}
    >
      <span
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning"
        aria-hidden
      />
      pending
    </span>
  );
}
