import type { GradientStop, SeriesGradientStops } from "./GradientLines";

export function createPieGradientProps(stops: SeriesGradientStops) {
  const defs = Object.entries(stops).map(([id, seriesStops]) => ({
    id: `pie-gradient-${id}`,
    type: "linearGradient" as const,
    colors: seriesStops.map((s: GradientStop) => ({
      offset: parseInt(s.offset),
      color: s.color,
      opacity: s.opacity ?? 1,
    })),
  }));

  const fill = Object.keys(stops).map((id) => ({
    match: { id },
    id: `pie-gradient-${id}`,
  }));

  return { defs, fill };
}
