import type { PointTooltipProps } from "@nivo/line";
import { getSeriesColor } from "@/lib/chart-colors";
import { explainSeries } from "./series-explanations";

interface LineTooltipConfig {
  xLabel: string;
  yLabel: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  // Display label for the series id (e.g. "QPU" -> "QPU20m"); defaults to
  // the id itself.
  seriesLabel?: (id: string) => string;
  // Swatch colour for the series id; defaults to getSeriesColor. Charts with
  // series ids outside the miner-category/node-id space (e.g. the Normalized
  // mode's QPU20m/QPU100%) supply their own resolver here instead of
  // duplicating this tooltip.
  colorFor?: (id: string) => string;
}

export function createLineTooltip({
  xLabel,
  yLabel,
  xFormat,
  yFormat,
  seriesLabel = (id) => id,
  colorFor = getSeriesColor,
}: LineTooltipConfig) {
  const fmt = (v: unknown, f?: (v: number) => string) => {
    const n = Number(v);
    return f ? f(n) : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  };

  return function LineTooltip({ point }: PointTooltipProps) {
    const color = colorFor(String(point.serieId));
    // Derived/extrapolated series (QPU20m, QPU100%, QPUWC) carry a plain-
    // language note so the reader understands what the number represents on
    // hover (bead ssf.8); self-explanatory ids resolve to undefined.
    const explanation = explainSeries(String(point.serieId));
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
          <span style={{ fontWeight: 600 }}>{seriesLabel(String(point.serieId))}</span>
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
        {explanation && (
          <div
            style={{
              marginTop: 6,
              paddingTop: 6,
              borderTop: "1px solid #e4e4e7",
              maxWidth: 240,
              color: "#52525c",
              fontSize: 11,
              lineHeight: 1.35,
            }}
          >
            {explanation}
          </div>
        )}
      </div>
    );
  };
}
