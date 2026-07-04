// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { ResponsiveLine } from "@nivo/line";

import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { TIME_RANGES, type TimeRange } from "@/components/charts/common/time-range";
import { nivoTheme } from "@/theme/nivo-theme";
import { useDifficultyHistory } from "./use-difficulty-history";

/**
 * Time-series of the chain's target energy threshold, windowed like a price
 * panel: 1H…ALL range buttons, x-axis clamped to the selected window (ALL
 * starts at the first measurement), served by /api/difficulty-history —
 * in-window rows plus the anchor row that pins the prevailing value at the
 * left edge, with the last value extended to now. No dead whitespace
 * regardless of where measurements cluster.
 *
 * min_diversity / min_solutions are intentionally not plotted — they're
 * small integers that share no scale with energy and surface in the Current
 * Difficulty tile + MyNode card instead.
 */
export function DifficultyChart() {
  const [range, setRange] = useState<TimeRange>("24h");
  const { points, windowStart, loading, error, isEmpty } = useDifficultyHistory(range);

  // Short windows read as clock times; long ones as dates.
  const timeFormat = range === "1h" || range === "6h" || range === "12h" ? "%H:%M" : "%b %d";

  return (
    <div className="border border-border bg-white p-4">
      <header className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-heading text-base text-ink-strong">Difficulty over time</h3>
          <p className="font-accent text-xs text-ink-subtle">
            Target energy ceiling (proofs must satisfy energy ≤ threshold). Winner-derived history +
            live snapshots from <code>difficulty_history</code>.
          </p>
        </div>
        <SegmentedControl
          options={TIME_RANGES}
          value={range}
          onChange={setRange}
          ariaLabel="Difficulty history range"
        />
      </header>
      <div data-qa="chart-difficulty-history" style={{ width: "100%", height: 240 }}>
        {isEmpty || (points.length === 0 && !loading) ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            {error
              ? `Difficulty history unavailable: ${error}`
              : "No difficulty data in this range yet"}
          </p>
        ) : (
          <ResponsiveLine
            data={[{ id: "Target energy", data: points }]}
            theme={nivoTheme}
            margin={{ top: 10, right: 30, bottom: 40, left: 60 }}
            xScale={{
              type: "time",
              format: "native",
              useUTC: false,
              precision: "second",
              // Clamp to the window start so the data fills the panel; ALL
              // follows the first measurement instead.
              min: windowStart ?? "auto",
              max: "auto",
            }}
            yScale={{ type: "linear", min: "auto", max: "auto" }}
            curve="stepAfter"
            enablePoints={false}
            lineWidth={2}
            axisBottom={{
              format: timeFormat,
              tickValues: 5,
              legend: "Time",
              legendOffset: 32,
              legendPosition: "middle",
            }}
            axisLeft={{
              legend: "Target energy",
              legendOffset: -50,
              legendPosition: "middle",
            }}
            useMesh
            enableCrosshair
          />
        )}
      </div>
    </div>
  );
}
