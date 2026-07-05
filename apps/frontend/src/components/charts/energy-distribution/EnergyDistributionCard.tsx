// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { ChartCard } from "@/components/layout/ChartCard";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type NodeScope,
} from "@/components/charts/common/SegToggle";
import { getSeriesColor } from "@/lib/chart-colors";
import { displayLabelForCategory } from "@/components/charts/common/qpu-label";
import { EnergyDistributionMiniChart } from "./EnergyDistributionMiniChart";
import { useEnergyDistributionByType, type TypeDistribution } from "./use-energy-distribution";

/**
 * "Energy Distribution" (WU10, nextsteps.md #6) — three per-type mini
 * histograms (CPU/GPU/QPU) in place of the old single stacked chart, each
 * normalised against ITSELF (its bars sum to ~100% of that type's own wins),
 * plus an All Nodes | Best Nodes scope toggle. Bucket/anchor math lives in
 * ./energy-buckets; the sign-convention writeup for "hardest" is there too.
 */
export function EnergyDistributionCard() {
  const [scope, setScope] = useState<NodeScope>("all");
  const { types } = useEnergyDistributionByType({ scope });

  return (
    <ChartCard
      title="Energy Distribution"
      subtitle="Each type's own wins, normalised against itself"
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
      <div className="grid h-full grid-cols-1 gap-3 sm:grid-cols-3">
        {types.map((t) => (
          <EnergyDistributionMiniPanel key={t.type} distribution={t} />
        ))}
      </div>
    </ChartCard>
  );
}

function EnergyDistributionMiniPanel({ distribution }: { distribution: TypeDistribution }) {
  const { type, totalWins } = distribution;
  return (
    <div
      className="flex h-full flex-col border border-border p-2"
      data-qa={`energy-distribution-${type}`}
    >
      <p className="mb-1 font-accent text-xs font-semibold" style={{ color: getSeriesColor(type) }}>
        {displayLabelForCategory(type)}
      </p>
      <div className="min-h-0 flex-1">
        {totalWins === 0 ? (
          <p className="flex h-full items-center justify-center font-accent text-xs text-ink-subtle">
            No wins yet
          </p>
        ) : (
          <EnergyDistributionMiniChart distribution={distribution} />
        )}
      </div>
    </div>
  );
}
