// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveBar, type BarDatum } from "@nivo/bar";

import { nivoTheme } from "../../../theme/nivo-theme";
import type { ModelBreakdown } from "./use-compute-available";

interface HardwareBreakdownProps {
  data: ModelBreakdown[];
  accent: string;
  emptyLabel: string;
}

export function HardwareBreakdown({ data, accent, emptyLabel }: HardwareBreakdownProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-accent text-sm text-brand-gray-3">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ResponsiveBar
      data={data as unknown as BarDatum[]}
      keys={["count"]}
      indexBy="model"
      layout="horizontal"
      margin={{ top: 10, right: 20, bottom: 40, left: 160 }}
      padding={0.25}
      colors={[accent]}
      borderRadius={4}
      enableLabel
      labelTextColor="#000000"
      labelSkipWidth={28}
      axisLeft={{ tickSize: 0, tickPadding: 8 }}
      axisBottom={{
        tickSize: 0,
        tickPadding: 6,
        legend: "Devices",
        legendPosition: "middle",
        legendOffset: 32,
      }}
      theme={nivoTheme}
      tooltip={({ indexValue, value, data: d }) => {
        const row = d as unknown as ModelBreakdown;
        return (
          <div
            style={{
              background: "#282828",
              color: "#DCDCDC",
              border: "1px solid #525252",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600 }}>{indexValue}</div>
            <div>{value} devices</div>
            <div style={{ opacity: 0.7 }}>{row.tflops.toFixed(1)} TFLOPS total</div>
          </div>
        );
      }}
    />
  );
}
