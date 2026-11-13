// SPDX-License-Identifier: AGPL-3.0-or-later

import { decaysApplied } from "@/lib/decays";
import { formatNumber } from "@/lib/format";
import { energyBandPosition, useDefaultTopology } from "@/lib/difficulty-curve";
import {
  formatBandPosition,
  formatEnergy,
  formatEnergyBand,
  formatFamily,
} from "@/lib/format-chain";
import type {
  BlockRecord,
  ChainHead,
  DifficultyRecord,
  MineableTopologyRecord,
} from "@quip/shared/telemetry";
import { BlockDetailCard, type DetailRow } from "./BlockDetailCard";
import type { CurrentRequirements } from "./use-my-node";

const PRIOR_ENERGY_ROWS = 3;

// Rows describing the default topology when it is a family topology: its
// generator and the energy band the difficulty moves inside. The legacy curve
// ratio does not apply, so the target is placed in the band instead.
function familyRows(targetEnergy: number, topology: MineableTopologyRecord | null): DetailRow[] {
  if (topology?.family == null) return [];
  const rows: DetailRow[] = [{ label: "Family", value: formatFamily(topology.family) }];
  if (topology.energyBand != null) {
    rows.push({ label: "Energy Band", value: formatEnergyBand(topology.energyBand) });
    const position = energyBandPosition(targetEnergy, topology.energyBand);
    if (position != null) {
      rows.push({ label: "Band Position", value: formatBandPosition(position) });
    }
  }
  return rows;
}

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
  const defaultTopology = useDefaultTopology();
  if (currentRequirements == null) {
    return (
      <BlockDetailCard
        label="Current Difficulty"
        rows={[{ label: "Status", value: "Awaiting first block" }]}
      />
    );
  }

  const notEnforced = <span className="text-ink-subtle italic">not enforced</span>;

  // Anchored on the BEST head (see lib/decays.ts): during the 2026-07-04
  // outage finality stalled and the old finalized-anchored count showed
  // "Decays Applied: 0" while the live target had already decayed.
  const decays = decaysApplied(chainHead, tipBlock ? tipBlock.substrateBlockNumber : null);

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
    { label: "Target Energy", value: `≤ ${formatEnergy(currentRequirements.difficultyEnergy)}` },
    ...familyRows(currentRequirements.difficultyEnergy, defaultTopology),
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
    ...(decays != null
      ? [{ label: "Decays Applied", value: formatNumber(decays) } satisfies DetailRow]
      : []),
    ...priorEnergies.map(
      (p): DetailRow => ({ label: `Prior @ #${p.block}`, value: `≤ ${formatEnergy(p.energy)}` }),
    ),
  ];

  return <BlockDetailCard label="Current Difficulty" rows={rows} />;
}
