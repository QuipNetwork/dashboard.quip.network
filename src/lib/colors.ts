import type { MinerCategory } from "../types/telemetry";

export const SERIES_COLORS: Record<MinerCategory, string> = {
  CPU: "#FF6C78",
  GPU: "#4CE0FF",
  QPU: "#67E347",
};

export const SERIES_GRADIENT: Record<MinerCategory, [string, string]> = {
  CPU: ["#FF6C78", "#FFE2DA"], // red-0 → red-1
  GPU: ["#4CE0FF", "#C2F8FD"], // blue-0 → blue-1
  QPU: ["#67E347", "#EEFF64"], // green-0 → green-1
};
