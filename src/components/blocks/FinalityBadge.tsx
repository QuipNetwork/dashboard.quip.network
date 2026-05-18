// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlockRecord } from "../../types/telemetry";

interface FinalityBadgeProps {
  block: BlockRecord;
}

/**
 * Compact chip indicating whether the substrate chain has finalized this
 * PoW block. Three render states:
 *
 *   - Not joined: substrateBlockNumber is null. The substrate worker
 *     hasn't observed a matching BlockWinner event yet (or substrate is
 *     unconfigured). Render nothing — operators on REST-only deployments
 *     shouldn't see a placeholder for data they don't have.
 *   - Pending: substrate block known, finalized=false. Yellow chip; the
 *     chain has produced this block but Grandpa hasn't finalized it yet.
 *   - Finalized: green chip. Finalization is monotonic; once shown, the
 *     chain has committed.
 */
export function FinalityBadge({ block }: FinalityBadgeProps) {
  if (block.substrateBlockNumber === null) return null;
  if (block.finalized) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-[#67E347]/40 bg-[#67E347]/15 px-1.5 py-0.5 font-accent text-[10px] text-[#67E347]"
        title={`Finalized at substrate block ${block.substrateBlockNumber}`}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#67E347]" aria-hidden />
        finalized
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-[#F5A623]/40 bg-[#F5A623]/15 px-1.5 py-0.5 font-accent text-[10px] text-[#F5A623]"
      title={`Substrate block ${block.substrateBlockNumber} awaiting Grandpa finalization`}
    >
      <span
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#F5A623]"
        aria-hidden
      />
      pending
    </span>
  );
}
