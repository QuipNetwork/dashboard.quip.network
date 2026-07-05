// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveBar, type BarDatum } from "@nivo/bar";

import { nivoTheme } from "@/theme/nivo-theme";
import type { ModelBreakdown } from "./use-compute-available";

interface HardwareBreakdownProps {
  data: ModelBreakdown[];
  accent: string;
  emptyLabel: string;
}

// Height per bar row (px). The chart grows with the model count and the
// card body scrolls (see NetworkView) — same pattern as NodeLeaderboard.
const ROW_HEIGHT = 26;
// Vertical space consumed by the ResponsiveBar margins (top + bottom axis).
const CHROME_HEIGHT = 50;
const MIN_CHART_HEIGHT = 240;

// Axis tick labels are 11px monospace in a 160px gutter — about 22 chars.
// Raw CPU brand strings ("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")
// front-clip into garbage at that width, so strip vendor noise and
// end-truncate. The tooltip always shows the full model name.
const MAX_LABEL_CHARS = 22;

export function formatModelLabel(model: string): string {
  const cleaned = model
    .replace(/\((?:R|TM)\)/gi, "")
    .replace(/@\s*[\d.]+\s*GHz/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= MAX_LABEL_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`;
}

/**
 * Audit fix #8: explicit adapter to BarDatum, replacing the previous
 * `as unknown as BarDatum[]` cast. The cast hid the structural mismatch
 * — adding any new property to ModelBreakdown would have silently passed
 * the cast but caused Nivo to render the new field as garbage data.
 *
 * The `satisfies BarDatum` annotation makes the type relationship
 * explicit at the call site: removing or renaming any of model/count/
 * tflops here is a compile error. Adding new fields to ModelBreakdown
 * keeps compiling because BarDatum is open-shape (`[key: string]: …`).
 */
type BarRow = BarDatum & { model: string; count: number; tflops: number };

function toBarRows(rows: ModelBreakdown[]): BarRow[] {
  return rows.map(
    (row) =>
      ({
        model: row.model,
        count: row.count,
        tflops: row.tflops,
      }) satisfies BarRow,
  );
}

export function HardwareBreakdown({ data, accent, emptyLabel }: HardwareBreakdownProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-60 items-center justify-center font-accent text-sm text-ink-subtle">
        {emptyLabel}
      </div>
    );
  }

  // Input arrives sorted by count descending; Nivo draws the first row at
  // the bottom of a horizontal chart, so reverse to put the biggest
  // populations at the top, visible before scrolling.
  const barData = toBarRows(data).reverse();
  const chartHeight = Math.max(MIN_CHART_HEIGHT, data.length * ROW_HEIGHT + CHROME_HEIGHT);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={barData}
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
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          format: (model) => formatModelLabel(String(model)),
        }}
        axisBottom={{
          tickSize: 0,
          tickPadding: 6,
          legend: "Devices",
          legendPosition: "middle",
          legendOffset: 32,
        }}
        theme={nivoTheme}
        tooltip={({ indexValue, value, data: d }) => {
          // d is BarDatum at the boundary; narrow to BarRow via a runtime
          // shape check rather than an unchecked cast. If a future Nivo
          // upgrade changes BarDatum, this fails loudly instead of silently.
          const row = d as BarRow;
          const tflops = typeof row.tflops === "number" ? row.tflops : 0;
          return (
            <div
              style={{
                background: "#ffffff",
                color: "#27272a",
                border: "1px solid #d4d4d8",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 600 }}>{indexValue}</div>
              <div>{value} devices</div>
              <div style={{ opacity: 0.7 }}>{tflops.toFixed(1)} TFLOPS total</div>
            </div>
          );
        }}
      />
    </div>
  );
}
