// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "@/lib/format";
import { formatBalance, formatEnergy, formatNonce } from "@/lib/format-chain";
import type { BlockRecord, MiningSubmissionRecord } from "@quip/shared/telemetry";
import { BlockDetailCard } from "./BlockDetailCard";

export function LastQBlockCard({
  lastWonBlock,
  lastWonSubmission,
  lastWonProblemNumber,
}: {
  lastWonBlock: BlockRecord | null;
  lastWonSubmission: MiningSubmissionRecord | undefined;
  lastWonProblemNumber: number | null;
}) {
  const lastSolutionTimeMs = lastWonBlock != null ? lastWonBlock.miningTime * 1000 : null;

  return (
    <BlockDetailCard
      label="Last Won QBlock Details"
      rows={
        lastWonBlock != null
          ? [
              // Folded in from the top row's standalone "Last QBlock Won"
              // tile — the two surfaced the same win, so the number now
              // lives here as the pane's own headline row.
              {
                label: "QBlock",
                value:
                  lastWonProblemNumber != null ? `#${formatNumber(lastWonProblemNumber)}` : "—",
              },
              {
                label: "Time to QBlock",
                value:
                  lastSolutionTimeMs != null && lastSolutionTimeMs > 0
                    ? formatDuration(lastSolutionTimeMs)
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
