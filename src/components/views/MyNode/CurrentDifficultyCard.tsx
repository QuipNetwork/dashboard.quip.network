// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatNumber } from "@/lib/format";
import type { BlockRecord, ChainHead, DifficultyRecord } from "@/types/telemetry";
import { BlockDetailCard, type DetailRow } from "./BlockDetailCard";
import type { CurrentRequirements } from "./use-my-node";

// One decay step per EpochLength blocks past LastProofBlock — matches the
// pallet's apply_decay on spec 101 (QuantumPowEpochLength = 100).
const QUANTUM_POW_EPOCH_LENGTH = 100;
const PRIOR_ENERGY_ROWS = 3;

export function CurrentDifficultyCard({
  currentRequirements,
  recentDifficulty,
  chainHead,
  tipBlock,
}: {
  currentRequirements: CurrentRequirements | null;
  recentDifficulty: DifficultyRecord[];
  chainHead: ChainHead | null;
  tipBlock: BlockRecord | null;
}) {
  if (currentRequirements == null) {
    return (
      <BlockDetailCard
        label="Current Difficulty"
        rows={[{ label: "Status", value: "Awaiting first block" }]}
      />
    );
  }

  const notEnforced = <span className="text-ink-subtle italic">not enforced</span>;

  const finalizedNum =
    chainHead && chainHead.finalizedBlockNumber ? Number(chainHead.finalizedBlockNumber) : null;
  const lastProofBlockNum = tipBlock ? Number(tipBlock.substrateBlockNumber) : null;
  const decaysApplied =
    finalizedNum != null && lastProofBlockNum != null
      ? Math.max(0, Math.floor((finalizedNum - lastProofBlockNum) / QUANTUM_POW_EPOCH_LENGTH))
      : null;

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
    { label: "Target Energy", value: `≤ ${currentRequirements.difficultyEnergy.toFixed(3)}` },
    {
      label: "Min Diversity",
      value:
        currentRequirements.minDiversity > 0
          ? currentRequirements.minDiversity.toFixed(3)
          : notEnforced,
    },
    {
      label: "Min Solutions",
      value:
        currentRequirements.minSolutions > 0
          ? formatNumber(currentRequirements.minSolutions)
          : notEnforced,
    },
    ...(decaysApplied != null
      ? [{ label: "Decays Applied", value: formatNumber(decaysApplied) } satisfies DetailRow]
      : []),
    ...priorEnergies.map(
      (p): DetailRow => ({ label: `Prior @ #${p.block}`, value: `≤ ${p.energy.toFixed(3)}` }),
    ),
  ];

  return <BlockDetailCard label="Current Difficulty" rows={rows} />;
}
