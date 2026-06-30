// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "@/lib/format";
import { formatBalance, formatEnergy, formatNonce } from "@/lib/format-chain";
import type { BlockRecord, MiningSubmissionRecord } from "@quip/shared/telemetry";
import { BlockDetailCard } from "./BlockDetailCard";

// `miningTime` is seconds (substrate-worker converts the block-delta via BABE
// slot duration before writing); divide back out for the "X blocks" display.
const BLOCK_TIME_SEC = 6;

export function LastQBlockCard({
  lastWonBlock,
  lastWonSubmission,
}: {
  lastWonBlock: BlockRecord | null;
  lastWonSubmission: MiningSubmissionRecord | undefined;
}) {
  const lastSolutionTimeMs = lastWonBlock != null ? lastWonBlock.miningTime * 1000 : null;
  const lastSolutionBlocks =
    lastWonBlock != null ? Math.round(lastWonBlock.miningTime / BLOCK_TIME_SEC) : null;

  return (
    <BlockDetailCard
      label="Last QBlock Details"
      rows={
        lastWonBlock != null
          ? [
              {
                label: "Time to QBlock",
                value:
                  lastSolutionTimeMs != null && lastSolutionTimeMs > 0
                    ? `${formatDuration(lastSolutionTimeMs)} · ${lastSolutionBlocks} blocks`
                    : "—",
              },
              {
                label: "Attempts",
                value:
                  lastWonSubmission != null ? formatNumber(lastWonSubmission.attemptCount) : "—",
              },
              { label: "Energy", value: formatEnergy(lastWonBlock.energy) },
              { label: "Diversity", value: lastWonBlock.diversity.toFixed(3) },
              { label: "Solutions", value: formatNumber(lastWonBlock.numValidSolutions) },
              { label: "Reward", value: formatBalance(lastWonBlock.reward) },
            ]
          : [{ label: "Status", value: "No wins yet" }]
      }
      footer={
        lastWonBlock
          ? `block #${lastWonBlock.substrateBlockNumber} · nonce: ${formatNonce(lastWonBlock.nonce)}`
          : undefined
      }
    />
  );
}
