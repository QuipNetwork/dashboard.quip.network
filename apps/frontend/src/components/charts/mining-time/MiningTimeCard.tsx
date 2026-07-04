// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { ChartCard } from "@/components/layout/ChartCard";
import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { TIME_RANGES, type TimeRange } from "@/components/charts/common/time-range";
import { MiningTimeChart } from "./MiningTimeChart";
import { MINING_TIME_GROUPINGS, useMiningTime, type MiningTimeGrouping } from "./use-mining-time";

/**
 * "Mining Time per QBlock" with the difficulty panel's 1H…ALL windowing plus
 * a card-local All | By Type toggle: "By Type" draws one line per processor
 * type (the default, honouring the global type selection), "All" one
 * aggregate line across every winner (docs/ui-layout.md, Compute item 5).
 */
export function MiningTimeCard() {
  const [range, setRange] = useState<TimeRange>("24h");
  const [grouping, setGrouping] = useState<MiningTimeGrouping>("byType");
  const { series, loading, error, isEmpty } = useMiningTime(range, grouping);

  return (
    <ChartCard
      title="Mining Time per QBlock"
      subtitle={
        grouping === "byType"
          ? "Time to qblock by processor type"
          : "Time to qblock across all miners"
      }
      actions={
        <>
          <SegmentedControl
            options={MINING_TIME_GROUPINGS}
            value={grouping}
            onChange={setGrouping}
            ariaLabel="Mining time grouping"
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
        <MiningTimeChart data={series} />
      )}
    </ChartCard>
  );
}
