// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "@/lib/format";
import { formatEnergy } from "@/lib/format-chain";
import type { BlockRecord } from "@quip/shared/telemetry";
import { BlockDetailCard, type DetailRow } from "@/components/views/MyNode/BlockDetailCard";

export function LastQBlockDetailsCard({
  lastBlock,
  lastBlockPflopSeconds,
}: {
  lastBlock: BlockRecord | null;
  lastBlockPflopSeconds: number | null;
}) {
  if (lastBlock == null) {
    return (
      <BlockDetailCard
        label="Last QBlock Details"
        rows={[{ label: "Status", value: "Awaiting first block" }]}
      />
    );
  }

  const rows: DetailRow[] = [
    { label: "QBlock", value: `#${lastBlock.substrateBlockNumber}` },
    {
      label: "Compute",
      value: lastBlockPflopSeconds != null ? `${lastBlockPflopSeconds.toFixed(1)} PFLOP·s` : "—",
    },
    { label: "Solved In", value: formatDuration(lastBlock.miningTime * 1000) },
    { label: "Energy", value: formatEnergy(lastBlock.energy) },
    { label: "Diversity", value: lastBlock.diversity.toFixed(3) },
    { label: "Solutions", value: formatNumber(lastBlock.numValidSolutions) },
  ];

  return <BlockDetailCard label="Last QBlock Details" rows={rows} />;
}
