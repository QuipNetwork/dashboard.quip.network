import { SERIES_COLORS, SERIES_GRADIENT } from "./colors";
import { useMinerColors } from "@/store/miner-colors";
import type { MinerCategory } from "@quip/shared/telemetry";

const TYPE_KEYS = new Set<string>(Object.keys(SERIES_COLORS));

// Some charts (MiningTimeChart, WinRateByDifficultyChart, raw byType/all
// mode) bake the QPU series' live budget-qualified display label ("QPU20m",
// "QPU45m", see charts/common/qpu-label.ts's useQpuDisplayLabel) directly
// into the series id, since there's no separate id/label slot to carry it.
// Match that pattern here too, or a live label divorced from the static
// "QPU20m" would be treated as an unrecognized node id.
const QPU_BUDGET_LABEL_PATTERN = /^QPU\d+(?:\.\d+)?m$/;

function resolveTypeKey(id: string): MinerCategory | null {
  if (TYPE_KEYS.has(id)) return id as MinerCategory;
  return QPU_BUDGET_LABEL_PATTERN.test(id) ? "QPU" : null;
}

/** Resolve a series color — uses type colors for CPU/GPU/QPU, miner colors for node IDs. */
export function getSeriesColor(id: string): string {
  const typeKey = resolveTypeKey(id);
  if (typeKey) return SERIES_COLORS[typeKey];
  return useMinerColors.getState().getColor(id);
}

/** Resolve gradient stops — returns [start, end] tuple. Falls back to solid color for node IDs. */
export function getSeriesGradient(id: string): [string, string] {
  const typeKey = resolveTypeKey(id);
  if (typeKey) return SERIES_GRADIENT[typeKey];
  const color = useMinerColors.getState().getColor(id);
  return [color, `${color}aa`];
}
