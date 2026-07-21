import type { MinerCategory } from "@quip/shared/telemetry";

export const SERIES_COLORS: Record<MinerCategory, string> = {
  CPU: "#E11D48",
  GPU: "#2563EB",
  QPU: "#059669",
  // v0.3 transitional: most miners have no hardware row yet (only self does).
  // "OTHER" is the bucket for unknown-category miners until peer-query lands.
  OTHER: "#71717B",
};

export const SERIES_GRADIENT: Record<MinerCategory, [string, string]> = {
  CPU: ["#E11D48", "#FB7185"],
  GPU: ["#2563EB", "#60A5FA"],
  QPU: ["#059669", "#34D399"],
  OTHER: ["#71717B", "#A1A1AA"],
};
