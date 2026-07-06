// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plain-language explanations for the derived/extrapolated chart series whose
// labels aren't self-evident (bead ssf.8). The by-difficulty and mining-time
// charts plot hypothetical or wall-clock series — "QPU20m", "QPU100%",
// "QPUWC" — and a reader can't tell from the label alone what the number
// represents. `createLineTooltip` looks each hovered series up here and, when
// an explanation exists, renders it under the value so the extrapolation is
// spelled out on hover.
//
// Keyed by the DISPLAYED series id (what the chart hands nivo and what the
// tooltip shows) — the normalized regimes are keyed by their
// NORMALIZED_SERIES_LABELS values, not the internal ids, so the lookup matches
// what the user actually sees. Self-explanatory ids (CPU/GPU/QPU, "All", raw
// node ids) intentionally have no entry and get no extra tooltip line.

import { QPU_DAILY_BUDGET_MIN } from "./normalized-composition";

export const SERIES_EXPLANATIONS: Record<string, string> = {
  QPU20m: `QPU as observed today — limited to its ~${QPU_DAILY_BUDGET_MIN} min/day D-Wave cloud budget (~1.4% of qblocks).`,
  "QPU100%": `The same QPU extrapolated to full-time participation: observed performance ÷ the ${QPU_DAILY_BUDGET_MIN} min/day budget fraction.`,
  QPUWC:
    "QPU wall-clock cost — dominated by D-Wave cloud round-trip and queue time, not on-chip device time.",
};

/**
 * Plain-language explanation for a derived series, or undefined for
 * self-explanatory ids. `idOrLabel` is the series id as displayed on the
 * chart/tooltip.
 */
export function explainSeries(idOrLabel: string): string | undefined {
  return SERIES_EXPLANATIONS[idOrLabel];
}
