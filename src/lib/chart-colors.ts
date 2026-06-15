import { SERIES_COLORS, SERIES_GRADIENT } from "./colors";
import { useMinerColors } from "@/store/miner-colors";
import type { MinerCategory } from "@/types/telemetry";

const TYPE_KEYS = new Set<string>(Object.keys(SERIES_COLORS));

/** Resolve a series color — uses type colors for CPU/GPU/QPU, miner colors for node IDs. */
export function getSeriesColor(id: string): string {
  if (TYPE_KEYS.has(id)) return SERIES_COLORS[id as MinerCategory];
  return useMinerColors.getState().getColor(id);
}

/** Resolve gradient stops — returns [start, end] tuple. Falls back to solid color for node IDs. */
export function getSeriesGradient(id: string): [string, string] {
  if (TYPE_KEYS.has(id)) return SERIES_GRADIENT[id as MinerCategory];
  const color = useMinerColors.getState().getColor(id);
  return [color, `${color}aa`];
}
