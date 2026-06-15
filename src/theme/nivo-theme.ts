import type { Theme } from "@nivo/core";

export const nivoTheme: Theme = {
  text: {
    fill: "#27272a",
    fontSize: 12,
    fontFamily: "'ABC Favorit Mono', monospace",
  },
  axis: {
    domain: {
      line: { stroke: "#d4d4d8", strokeWidth: 1 },
    },
    ticks: {
      line: { stroke: "#d4d4d8", strokeWidth: 1 },
      text: { fill: "#52525c", fontSize: 11 },
    },
    legend: {
      text: { fill: "#27272a", fontSize: 12 },
    },
  },
  grid: {
    line: { stroke: "#e4e4e7", strokeWidth: 1 },
  },
  crosshair: {
    line: { stroke: "#52525c", strokeWidth: 1 },
  },
  tooltip: {
    container: {
      background: "#ffffff",
      color: "#27272a",
      fontSize: 12,
      borderRadius: "0",
      border: "1px solid #d4d4d8",
      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
    },
  },
};
