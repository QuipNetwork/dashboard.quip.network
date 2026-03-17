import type { Theme } from "@nivo/core";

export const nivoTheme: Theme = {
  text: {
    fill: "#DCDCDC",
    fontSize: 12,
    fontFamily: "'ABC Favotit Mono', monospace",
  },
  axis: {
    domain: {
      line: { stroke: "#525252", strokeWidth: 1 },
    },
    ticks: {
      line: { stroke: "#525252", strokeWidth: 1 },
      text: { fill: "#A9A9A9", fontSize: 11 },
    },
    legend: {
      text: { fill: "#DCDCDC", fontSize: 12 },
    },
  },
  grid: {
    line: { stroke: "#282828", strokeWidth: 1 },
  },
  crosshair: {
    line: { stroke: "#A9A9A9", strokeWidth: 1 },
  },
  tooltip: {
    container: {
      background: "#282828",
      color: "#DCDCDC",
      fontSize: 12,
      borderRadius: "6px",
      border: "1px solid #525252",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    },
  },
};
