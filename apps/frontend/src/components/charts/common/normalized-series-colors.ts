// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Colour/gradient resolution for the Normalized-mode series ids (CPU, GPU,
// QPU20m, QPU100%) — shared by WinRateByDifficultyChart and MiningTimeChart,
// the two charts with a "Normalized" scope (charts/common/normalized-composition).
// QPU100% needs a colour distinguishable from the QPU emerald while still
// reading as "quantum" — lime, derived here rather than in lib/colors (which
// stays type-keyed to MinerCategory and knows nothing of the two QPU regimes).

import { createGradientLines } from "@/components/charts/common/GradientLines";
import { NORMALIZED_SERIES_LABELS } from "@/components/charts/common/normalized-composition";
import { getSeriesColor } from "@/lib/chart-colors";
import { SERIES_COLORS, SERIES_GRADIENT } from "@/lib/colors";

const QPU100_COLOR = "#84CC16";
const QPU100_GRADIENT: [string, string] = ["#84CC16", "#BEF264"];

// Normalized-mode series render under their display labels; the two QPU
// regimes aren't type keys, so resolve their colours here.
const EXTRA_SERIES_COLORS: Record<string, string> = {
  [NORMALIZED_SERIES_LABELS.QPU20m]: SERIES_COLORS.QPU,
  [NORMALIZED_SERIES_LABELS.QPU100]: QPU100_COLOR,
};

/** Swatch/line colour for a series id, covering the Normalized QPU20m/QPU100% ids. */
export function colorForNormalizedSeries(id: string): string {
  return EXTRA_SERIES_COLORS[id] ?? getSeriesColor(id);
}

/** Gradient-fill layer for a Normalized-capable line chart, keyed the same way. */
export const normalizedSeriesGradientLines = createGradientLines(
  Object.fromEntries(
    Object.entries({
      ...SERIES_GRADIENT,
      [NORMALIZED_SERIES_LABELS.QPU20m]: SERIES_GRADIENT.QPU,
      [NORMALIZED_SERIES_LABELS.QPU100]: QPU100_GRADIENT,
    }).map(([id, [from, to]]) => [
      id,
      [
        { offset: "0%", color: from },
        { offset: "100%", color: to },
      ],
    ]),
  ),
);
