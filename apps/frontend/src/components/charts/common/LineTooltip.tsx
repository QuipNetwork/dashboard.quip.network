import type { PointTooltipProps } from "@nivo/line";
import { getSeriesColor } from "@/lib/chart-colors";

interface LineTooltipConfig {
  xLabel: string;
  yLabel: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
}

export function createLineTooltip({ xLabel, yLabel, xFormat, yFormat }: LineTooltipConfig) {
  const fmt = (v: unknown, f?: (v: number) => string) => {
    const n = Number(v);
    return f ? f(n) : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  };

  return function LineTooltip({ point }: PointTooltipProps) {
    const color = getSeriesColor(String(point.serieId));
    return (
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
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor: color,
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#F2F2F2", fontWeight: 600 }}>{String(point.serieId)}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>
            <span style={{ color: "#52525c" }}>{xLabel}: </span>
            {fmt(point.data.x, xFormat)}
          </span>
          <span>
            <span style={{ color: "#52525c" }}>{yLabel}: </span>
            {fmt(point.data.y, yFormat)}
          </span>
        </div>
      </div>
    );
  };
}
