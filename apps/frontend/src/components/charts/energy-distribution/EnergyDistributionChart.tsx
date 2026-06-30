import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import { OverlappingBarsLayer } from "@/components/charts/common/OverlappingBarsLayer";
import { formatDifficultyTickShort, useDifficultyCurveK } from "@/lib/difficulty-curve";
import type { HistogramData } from "@/lib/histogram";

export interface EnergyDistributionChartProps {
  data: HistogramData;
}

export function EnergyDistributionChart({ data }: EnergyDistributionChartProps) {
  const k = useDifficultyCurveK();
  if (data.data.length === 0) return null;

  // Bins are built ascending (most-negative first). The energy axis reads
  // "harder = more negative on the right", so reverse the band order to put
  // the most-negative bin on the right edge.
  const bars = [...data.data].reverse();

  return (
    <div data-qa="chart-energy-distribution" style={{ width: "100%", height: "100%" }}>
      <ResponsiveBar
        data={bars}
        keys={data.keys}
        indexBy="bin"
        theme={nivoTheme}
        colors={(bar) => getSeriesColor(String(bar.id))}
        groupMode="grouped"
        margin={{ top: 10, right: 20, bottom: 50, left: 60 }}
        padding={0.15}
        innerPadding={0}
        enableLabel={false}
        enableGridY={true}
        layers={["grid", "axes", OverlappingBarsLayer, "markers", "legends"]}
        axisBottom={{
          legend: "(lower energy == more difficult)",
          legendOffset: 40,
          legendPosition: "middle",
          tickRotation: -45,
          format: (v) => formatDifficultyTickShort(Number(v), k),
        }}
        axisLeft={{
          legend: "Frequency / Unit",
          legendOffset: -50,
          legendPosition: "middle",
        }}
        legends={[
          {
            dataFrom: "keys",
            anchor: "top-right",
            direction: "column",
            itemWidth: 60,
            itemHeight: 18,
            symbolSize: 10,
            symbolShape: "square",
          },
        ]}
      />
    </div>
  );
}
