// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration } from "@/lib/format";
import type { BlockRecord } from "@quip/shared/telemetry";
import { BlockDetailCard, type DetailRow } from "@/components/views/MyNode/BlockDetailCard";

export function CurrentQBlockDetailsCard({
  lastBlock,
  currentBlockPflopSeconds,
  currentBlockElapsedSeconds,
}: {
  lastBlock: BlockRecord | null;
  currentBlockPflopSeconds: number | null;
  currentBlockElapsedSeconds: number | null;
}) {
  if (lastBlock == null) {
    return (
      <BlockDetailCard
        label="Current QBlock Details"
        rows={[{ label: "Status", value: "Awaiting first block" }]}
      />
    );
  }

  const rows: DetailRow[] = [
    { label: "QBlock", value: `#${Number(lastBlock.substrateBlockNumber) + 1}` },
    {
      label: "Compute",
      value:
        currentBlockPflopSeconds != null ? `${currentBlockPflopSeconds.toFixed(1)} PFLOP·s` : "—",
    },
    {
      label: "Elapsed",
      value:
        currentBlockElapsedSeconds != null
          ? `${formatDuration(currentBlockElapsedSeconds * 1000)} and counting`
          : "—",
    },
  ];

  return <BlockDetailCard label="Current QBlock Details" rows={rows} />;
}
