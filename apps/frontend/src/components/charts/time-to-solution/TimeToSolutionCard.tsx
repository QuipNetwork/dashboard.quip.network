// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { ChartCard } from "@/components/layout/ChartCard";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type NodeScope,
} from "@/components/charts/common/SegToggle";
import { useUIStore } from "@/store/ui-store";
import { TimeToSolutionChart } from "./TimeToSolutionChart";
import { useTimeToSolution } from "./use-time-to-solution";

/**
 * "Time to QBlock" card: owns the histogram hook and a card-local
 * "All Nodes | Best Nodes" scope toggle (nextsteps.md #4c), mirroring
 * MiningTimeCard's card-owns-its-hook idiom. Subtitle still branches on the
 * global byType/byNode aggregation mode, as it did in ComputeAvailableView.
 */
export function TimeToSolutionCard() {
  const [scope, setScope] = useState<NodeScope>("all");
  const byType = useUIStore((s) => s.aggregationMode) === "byType";
  const data = useTimeToSolution({ scope });

  return (
    <ChartCard
      title="Time to QBlock"
      subtitle={
        byType
          ? "Normalised frequency per unit by mining time"
          : "Normalised frequency per miner by mining time"
      }
      actions={
        <SegToggle
          value={scope}
          onChange={setScope}
          options={NODE_SCOPE_OPTIONS}
          ariaLabel="Time to QBlock node scope"
        />
      }
    >
      <TimeToSolutionChart data={data} />
    </ChartCard>
  );
}
