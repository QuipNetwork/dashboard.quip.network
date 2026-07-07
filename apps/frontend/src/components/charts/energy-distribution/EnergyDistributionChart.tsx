// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One grouped bar chart of winning energies by processor type over the shared
// energy buckets (WU10, ssf.6): replaces the three separate self-normalised
// mini-histograms. Each type keeps its own-normalised percentages (its bars
// sum to ~100% of that type's own wins), rendered side-by-side per bucket so
// the distribution shapes are directly comparable across types.

import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import { displayLabelForCategory, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import type { MinerCategory } from "@quip/shared/telemetry";
import type { TypeDistribution } from "./use-energy-distribution";

export interface EnergyDistributionChartProps {
  types: TypeDistribution[];
}

export function EnergyDistributionChart({ types }: EnergyDistributionChartProps) {
  const qpuLabel = useQpuDisplayLabel();
  // Buckets are the same shared grid across every type (see energy-buckets).
  const buckets = types[0]?.buckets ?? [];
  if (buckets.length === 0) return null;

  const keys = types.map((t) => t.type);
  const data = buckets.map((b, i) => {
    const row: Record<string, string | number> = { bin: b.label };
    for (const t of types) row[t.type] = t.percentages[i] ?? 0;
    return row;
  });

  const labelFor = (k: string): string =>
    k === "QPU" ? qpuLabel : displayLabelForCategory(k as MinerCategory);

  return (
    <div data-qa="chart-energy-distribution" style={{ width: "100%", height: "100%" }}>
      <ResponsiveBar
        data={data}
        keys={keys}
        indexBy="bin"
        groupMode="grouped"
        theme={nivoTheme}
        colors={(bar) => getSeriesColor(String(bar.id))}
        margin={{ top: 24, right: 20, bottom: 64, left: 48 }}
        padding={0.25}
        innerPadding={1}
        enableLabel={false}
        enableGridY={true}
        gridYValues={4}
        axisBottom={{
          tickRotation: -45,
          legend: "Winning energy",
          legendOffset: 54,
          legendPosition: "middle",
        }}
        axisLeft={{
          tickValues: 4,
          format: (v) => `${v}%`,
          legend: "Share of type's wins",
          legendOffset: -40,
          legendPosition: "middle",
        }}
        legendLabel={(d) => labelFor(String(d.id))}
        legends={[
          {
            dataFrom: "keys",
            anchor: "top-right",
            direction: "row",
            translateY: -18,
            itemWidth: 64,
            itemHeight: 16,
            symbolSize: 10,
            symbolShape: "circle",
          },
        ]}
        tooltip={({ id, value, indexValue, color }) => (
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #d4d4d8",
              borderRadius: 6,
              padding: "8px 12px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              fontFamily: "'ABC Favotit Mono', monospace",
              fontSize: 12,
              color: "#27272a",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4, color }}>{labelFor(String(id))}</div>
            <div>
              {value}% of wins in {String(indexValue)}
            </div>
          </div>
        )}
      />
    </div>
  );
}
