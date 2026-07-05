// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import type { TypeDistribution } from "./use-energy-distribution";

export interface EnergyDistributionMiniChartProps {
  distribution: TypeDistribution;
}

/** One processor type's self-normalised histogram — a single-key bar chart over its own bucket percentages. */
export function EnergyDistributionMiniChart({ distribution }: EnergyDistributionMiniChartProps) {
  const { type, buckets, percentages } = distribution;
  const data = buckets.map((b, i) => ({ bin: b.label, value: percentages[i] ?? 0 }));
  const color = getSeriesColor(type);

  return (
    <ResponsiveBar
      data={data}
      keys={["value"]}
      indexBy="bin"
      theme={nivoTheme}
      colors={() => color}
      margin={{ top: 6, right: 8, bottom: 42, left: 32 }}
      padding={0.2}
      enableLabel={false}
      enableGridY={true}
      gridYValues={3}
      axisBottom={{ tickRotation: -45 }}
      axisLeft={{ tickValues: 3, format: (v) => `${v}%` }}
    />
  );
}
