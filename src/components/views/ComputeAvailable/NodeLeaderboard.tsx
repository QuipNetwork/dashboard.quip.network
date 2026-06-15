// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveBar, type BarDatum } from "@nivo/bar";
import { useState } from "react";

import { nivoTheme } from "@/theme/nivo-theme";
import { SearchInput } from "@/components/common/SearchInput";
import type { PerNodeTflops } from "./use-compute-available";

interface NodeLeaderboardProps {
  nodes: PerNodeTflops[];
  accent: string;
}

// Height per row of the chart (px). Chart scrolls vertically when the total
// exceeds the viewport cap on the wrapper below.
const ROW_HEIGHT = 28;
const MIN_CHART_HEIGHT = 240;

export function filterNodes(nodes: readonly PerNodeTflops[], query: string): PerNodeTflops[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];
  return nodes.filter(
    (n) => n.nodeName.toLowerCase().includes(q) || n.address.toLowerCase().includes(q),
  );
}

export function NodeLeaderboard({ nodes, accent }: NodeLeaderboardProps) {
  const [query, setQuery] = useState("");

  if (nodes.length === 0) {
    return (
      <div className="flex h-60 items-center justify-center font-accent text-sm text-brand-gray-3">
        No node data reported
      </div>
    );
  }

  const filtered = filterNodes(nodes, query);
  const chartHeight = Math.max(MIN_CHART_HEIGHT, filtered.length * ROW_HEIGHT);
  const addrToName = new Map(filtered.map((n) => [n.address, n.nodeName]));

  return (
    <div className="flex flex-col gap-2">
      <SearchInput value={query} onChange={setQuery} placeholder="Search nodes…" />
      {filtered.length === 0 ? (
        <div className="flex h-60 items-center justify-center font-accent text-sm text-brand-gray-3">
          No nodes match “{query}”
        </div>
      ) : (
        <div className="max-h-[600px] overflow-y-auto">
          <div style={{ height: chartHeight }}>
            <ResponsiveBar
              data={filtered as unknown as BarDatum[]}
              keys={["tflops"]}
              indexBy="address"
              layout="horizontal"
              margin={{ top: 10, right: 40, bottom: 40, left: 200 }}
              padding={0.25}
              colors={[accent]}
              borderRadius={4}
              enableLabel
              labelTextColor="#000000"
              labelSkipWidth={40}
              label={(d) => `${Number(d.value ?? 0).toFixed(1)}`}
              axisLeft={{
                tickSize: 0,
                tickPadding: 8,
                format: (address) => addrToName.get(String(address)) ?? String(address),
              }}
              axisBottom={{
                tickSize: 0,
                tickPadding: 6,
                legend: "TFLOPS (FP32)",
                legendPosition: "middle",
                legendOffset: 32,
              }}
              theme={nivoTheme}
              tooltip={({ value, data: d }) => {
                const row = d as unknown as PerNodeTflops;
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
                    <div style={{ fontWeight: 600 }}>{row.nodeName}</div>
                    <div>{Number(value).toFixed(1)} TFLOPS</div>
                    <div style={{ opacity: 0.7 }}>{row.address}</div>
                  </div>
                );
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
