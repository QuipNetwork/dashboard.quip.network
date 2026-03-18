import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "../../../theme/nivo-theme";
import { SERIES_COLORS } from "../../../lib/colors";
import { OverlappingBarsLayer } from "../common/OverlappingBarsLayer";
import type { MinerCategory } from "../../../types/telemetry";
import type { HistogramData } from "../../../lib/histogram";

export interface EnergyDistributionChartProps {
  data: HistogramData;
}

export function EnergyDistributionChart({ data }: EnergyDistributionChartProps) {
  if (data.data.length === 0) return null;

  return (
    <div data-qa="chart-energy-distribution" style={{ width: "100%", height: "100%" }}>
      <ResponsiveBar
        data={data.data}
        keys={data.keys}
        indexBy="bin"
        theme={nivoTheme}
        colors={(bar) => SERIES_COLORS[bar.id as MinerCategory] ?? "#999"}
        groupMode="grouped"
        margin={{ top: 10, right: 20, bottom: 50, left: 60 }}
        padding={0.15}
        innerPadding={0}
        enableLabel={false}
        enableGridY={true}
        layers={["grid", "axes", OverlappingBarsLayer, "markers", "legends"]}
        axisBottom={{
          legend: "Energy",
          legendOffset: 40,
          legendPosition: "middle",
          tickRotation: -45,
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
