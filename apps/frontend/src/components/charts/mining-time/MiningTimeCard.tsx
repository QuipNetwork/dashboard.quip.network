// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { ChartCard } from "@/components/layout/ChartCard";
import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { TIME_RANGES, type TimeRange } from "@/components/charts/common/time-range";
import { MiningTimeChart } from "./MiningTimeChart";
import {
  MINING_METRICS,
  MINING_TIME_GROUPINGS,
  useMiningTime,
  type MiningMetric,
  type MiningTimeGrouping,
} from "./use-mining-time";

// Subtitles say "total" deliberately: the value is now summed over every node
// that raced the qblock (all device kinds), not just the winner — see
// use-mining-time's header (participation-level data).
function subtitleFor(grouping: MiningTimeGrouping, metric: MiningMetric): string {
  const noun = metric === "energy" ? "device energy" : "device time";
  if (grouping === "normalized") return `Share of total ${noun} at the reference composition`;
  if (grouping === "byType") return `Total ${noun} per qblock by processor type`;
  return `Total ${noun} per qblock across all participants`;
}

/**
 * "Mining per QBlock" with the difficulty panel's 1H…ALL windowing plus two
 * card-local toggles: grouping "All | By Type | Normalized" (nextsteps #8a —
 * Normalized reuses the charts/common/normalized-composition model) and
 * metric "Time | Energy" (#8b — total participant device seconds vs their
 * estimated joules).
 */
export function MiningTimeCard() {
  const [range, setRange] = useState<TimeRange>("24h");
  const [grouping, setGrouping] = useState<MiningTimeGrouping>("byType");
  const [metric, setMetric] = useState<MiningMetric>("time");
  const { series, loading, error, isEmpty } = useMiningTime(range, grouping, metric);

  return (
    <ChartCard
      title="Mining per QBlock"
      subtitle={subtitleFor(grouping, metric)}
      actions={
        <>
          <SegmentedControl
            options={MINING_TIME_GROUPINGS}
            value={grouping}
            onChange={setGrouping}
            ariaLabel="Mining time grouping"
          />
          <SegmentedControl
            options={MINING_METRICS}
            value={metric}
            onChange={setMetric}
            ariaLabel="Mining metric"
          />
          <SegmentedControl
            options={TIME_RANGES}
            value={range}
            onChange={setRange}
            ariaLabel="Mining time range"
          />
        </>
      }
    >
      {isEmpty || (series.length === 0 && !loading) ? (
        <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
          {error ? `Mining history unavailable: ${error}` : "No qblocks in this range yet"}
        </p>
      ) : (
        <MiningTimeChart data={series} metric={metric} normalized={grouping === "normalized"} />
      )}
    </ChartCard>
  );
}
