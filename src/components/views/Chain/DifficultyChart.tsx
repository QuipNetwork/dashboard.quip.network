// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveLine } from "@nivo/line";

import { nivoTheme } from "../../../theme/nivo-theme";
import { useTelemetryStore } from "../../../store/telemetry-store";

/**
 * Time-series of `quantum_pow.Difficulty` snapshots. Surfaces all four
 * dimensions (energy ceiling, min diversity, min solutions, min quality)
 * so operators can spot adjustment-period transitions at a glance.
 *
 * Three of the four values are floats around the [0, 20] range on
 * quip-protocol-rs spec 101; min_solutions is a small integer. They share
 * an axis comfortably, but min_solutions is split onto a second yScale —
 * Nivo doesn't easily multi-axis, so we render two charts stacked. For
 * the first pass: single chart with all four series sharing a linear y.
 *
 * Hides itself when fewer than 2 snapshots exist (chart needs at least
 * one segment to draw a line).
 */
export function DifficultyChart() {
  const recent = useTelemetryStore((s) => s.recentDifficulty);
  if (recent.length < 2) return null;

  // recentDifficulty arrives newest-first; reverse for ascending X so the
  // line draws left-to-right naturally. Use the substrate block number as
  // the X anchor — meaningful units, monotonic, dense enough for a
  // ~hundred-point timeline.
  const ascending = [...recent].reverse();
  const toPoint = (key: "difficultyEnergy" | "minDiversity" | "minSolutions" | "minQuality") =>
    ascending.map((d) => ({ x: Number(d.observedAtBlock), y: d[key] }));

  const data = [
    { id: "Energy ceiling", data: toPoint("difficultyEnergy") },
    { id: "Min diversity", data: toPoint("minDiversity") },
    { id: "Min quality", data: toPoint("minQuality") },
    { id: "Min solutions", data: toPoint("minSolutions") },
  ];

  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-4 backdrop-blur-xl">
      <header className="mb-2">
        <h3 className="font-heading text-base text-brand-gray-5">
          Difficulty over time
        </h3>
        <p className="font-accent text-xs text-brand-gray-3">
          Last {recent.length} adjustment snapshots from <code>quantum_pow.Difficulty</code>.
        </p>
      </header>
      <div data-qa="chart-difficulty-history" style={{ width: "100%", height: 240 }}>
        <ResponsiveLine
          data={data}
          theme={nivoTheme}
          margin={{ top: 10, right: 110, bottom: 40, left: 50 }}
          xScale={{ type: "linear" }}
          yScale={{ type: "linear", min: "auto" }}
          curve="monotoneX"
          enablePoints={false}
          lineWidth={2}
          axisBottom={{
            legend: "Substrate block",
            legendOffset: 32,
            legendPosition: "middle",
          }}
          axisLeft={{
            legend: "Value (milli-units / count)",
            legendOffset: -42,
            legendPosition: "middle",
          }}
          useMesh
          enableCrosshair
          legends={[
            {
              anchor: "right",
              direction: "column",
              itemWidth: 100,
              itemHeight: 18,
              symbolSize: 10,
              symbolShape: "square",
              translateX: 100,
            },
          ]}
        />
      </div>
    </div>
  );
}
