// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "@/lib/format";
import { formatEnergy, formatNonce, shortAddress } from "@/lib/format-chain";
import type { BlockRecord } from "@quip/shared/telemetry";
import { BlockDetailCard, type DetailRow } from "@/components/views/MyNode/BlockDetailCard";

// Bumped from the shared BlockDetailCard default so this card's headline
// reads larger and near-black instead of the small uppercase subtle tag
// every other BlockDetailCard caller uses.
const TITLE_CLASS_NAME = "font-heading text-lg text-ink-strong";

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
        labelClassName={TITLE_CLASS_NAME}
        rows={[{ label: "Status", value: "Awaiting first block" }]}
      />
    );
  }

  const rows: DetailRow[] = [
    { label: "QBlock ID", value: `#${lastBlock.qblockId}` },
    { label: "Block #", value: `#${lastBlock.substrateBlockNumber}` },
    {
      label: "Compute",
      value: lastBlockPflopSeconds != null ? `${lastBlockPflopSeconds.toFixed(1)} PFLOP·s` : "—",
    },
    { label: "Solved In", value: formatDuration(lastBlock.miningTime * 1000) },
    { label: "Target Energy", value: `≤ ${formatEnergy(lastBlock.difficultyEnergy)}` },
    { label: "Energy", value: formatEnergy(lastBlock.energy) },
    { label: "Diversity", value: lastBlock.diversity.toFixed(3) },
    { label: "Solutions", value: formatNumber(lastBlock.numValidSolutions) },
    {
      label: "QBlock Hash",
      value: <span title={lastBlock.blockHash}>{shortAddress(lastBlock.blockHash, 10, 8)}</span>,
    },
    { label: "Nonce", value: formatNonce(lastBlock.nonce) },
  ];

  return (
    <BlockDetailCard label="Last QBlock Details" labelClassName={TITLE_CLASS_NAME} rows={rows} />
  );
}
