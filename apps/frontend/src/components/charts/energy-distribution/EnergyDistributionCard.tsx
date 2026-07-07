// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { ChartCard } from "@/components/layout/ChartCard";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type NodeScope,
} from "@/components/charts/common/SegToggle";
import { EnergyDistributionChart } from "./EnergyDistributionChart";
import { useEnergyDistributionByType } from "./use-energy-distribution";

/**
 * "Energy Distribution" (WU10, ssf.6) — a single grouped bar chart of winning
 * energies by processor type (CPU/GPU/QPU) over the shared energy buckets,
 * plus an All Nodes | Best Nodes scope toggle. Replaces the three separate
 * per-type mini-histograms. Each type is normalised against ITSELF (its bars
 * sum to ~100% of that type's own wins); bucket/anchor math and the "which end
 * is hardest" sign-convention writeup live in ./energy-buckets.
 */
export function EnergyDistributionCard() {
  const [scope, setScope] = useState<NodeScope>("all");
  const { types } = useEnergyDistributionByType({ scope });
  const hasWins = types.some((t) => t.totalWins > 0);

  return (
    <ChartCard
      title="Energy Distribution"
      subtitle="Winning energies by type"
      bodyClassName="h-[420px]"
      actions={
        <SegToggle
          value={scope}
          onChange={setScope}
          options={NODE_SCOPE_OPTIONS}
          ariaLabel="Node scope"
        />
      }
    >
      {hasWins ? (
        <EnergyDistributionChart types={types} />
      ) : (
        <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
          No wins yet
        </p>
      )}
    </ChartCard>
  );
}
