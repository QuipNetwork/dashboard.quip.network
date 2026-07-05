// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "@/lib/format";
import { formatEnergy } from "@/lib/format-chain";
import type { BlockRecord, DifficultyRecord } from "@quip/shared/telemetry";
import { BlockDetailCard, type DetailRow } from "@/components/views/MyNode/BlockDetailCard";
import type { CurrentRequirements } from "@/components/views/MyNode/use-my-node";

// Ported from MyNode/CurrentDifficultyCard — caps the "Prior @ #block" rows
// so a run of decay-only polls (same energy, new block) doesn't flood the
// card with duplicate thresholds.
const PRIOR_ENERGY_ROWS = 3;

export function CurrentQBlockDetailsCard({
  lastBlock,
  currentBlockPflopSeconds,
  currentBlockElapsedSeconds,
  currentDifficulty,
  recentDifficulty,
  decays,
}: {
  lastBlock: BlockRecord | null;
  currentBlockPflopSeconds: number | null;
  currentBlockElapsedSeconds: number | null;
  // Precedence-resolved by the view (live poll ?? tip-block snapshot) — see
  // the comment at its call site for why this stays local to Compute rather
  // than sourcing MyNode's `useMyNode().currentRequirements`.
  currentDifficulty: CurrentRequirements | null;
  recentDifficulty: DifficultyRecord[];
  decays: number | null;
}) {
  if (lastBlock == null && currentDifficulty == null) {
    return (
      <BlockDetailCard
        label="Current QBlock Details"
        rows={[{ label: "Status", value: "Awaiting first block" }]}
      />
    );
  }

  const notEnforced = <span className="text-ink-subtle italic">not enforced</span>;

  const priorEnergies: Array<{ block: string; energy: number }> = [];
  if (recentDifficulty.length > 1) {
    const seen = new Set<number>();
    for (let i = 1; i < recentDifficulty.length && priorEnergies.length < PRIOR_ENERGY_ROWS; i++) {
      const r = recentDifficulty[i]!;
      if (seen.has(r.difficultyEnergy)) continue;
      seen.add(r.difficultyEnergy);
      priorEnergies.push({ block: r.observedAtBlock, energy: r.difficultyEnergy });
    }
  }

  const rows: DetailRow[] = [
    {
      label: "QBlock",
      value: lastBlock != null ? `#${Number(lastBlock.substrateBlockNumber) + 1}` : "—",
    },
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
    ...(currentDifficulty != null
      ? ([
          {
            label: "Target Energy",
            value: `≤ ${formatEnergy(currentDifficulty.difficultyEnergy)}`,
          },
          {
            label: "Min Diversity",
            value:
              currentDifficulty.minDiversity > 0
                ? currentDifficulty.minDiversity.toFixed(3)
                : notEnforced,
          },
          {
            label: "Min Solutions",
            value:
              currentDifficulty.minSolutions > 0
                ? formatNumber(currentDifficulty.minSolutions)
                : notEnforced,
          },
        ] satisfies DetailRow[])
      : []),
    ...(decays != null
      ? [{ label: "Decays Applied", value: formatNumber(decays) } satisfies DetailRow]
      : []),
    ...priorEnergies.map(
      (p): DetailRow => ({ label: `Prior @ #${p.block}`, value: `≤ ${formatEnergy(p.energy)}` }),
    ),
  ];

  return <BlockDetailCard label="Current QBlock Details" rows={rows} />;
}
