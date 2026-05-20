import type { MinerCategory } from "../types/telemetry";

export const SERIES_COLORS: Record<MinerCategory, string> = {
  CPU: "#FF6C78",
  GPU: "#4CE0FF",
  QPU: "#67E347",
  // v0.3 transitional: most miners have no hardware row yet (only self does).
  // "OTHER" is the bucket for unknown-category miners until peer-query lands.
  OTHER: "#A9A9A9",
};

export const SERIES_GRADIENT: Record<MinerCategory, [string, string]> = {
  CPU: ["#FF6C78", "#FFA7A9"],
  GPU: ["#4CE0FF", "#C2F8FD"], // blue-0 → blue-1
  QPU: ["#67E347", "#EEFF64"], // green-0 → green-1
  OTHER: ["#A9A9A9", "#DCDCDC"],
};
