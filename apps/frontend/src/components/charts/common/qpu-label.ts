// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Display-only QPU label: the last advertised QPU access budget, per
// nextsteps.md Compute-By-Type #2. The budget lives on-chain as
// `NodeMinerEntry.dailyBudget` (packages/shared/telemetry/node.ts) but isn't
// indexed/parsed yet — it rides unparsed inside `node_descriptors.descriptor`
// jsonb — so this assumes 20 min/day per spec. Bump `QPU_DAILY_BUDGET_MIN`
// (normalized-composition.ts) when indexing lands; this file needs no change.

import { QPU_DAILY_BUDGET_MIN } from "./normalized-composition";

/** "QPU20m" — the QPU series label, budget-qualified for display. */
export function qpuDisplayLabel(): string {
  return `QPU${QPU_DAILY_BUDGET_MIN}m`;
}

/**
 * Display label for a miner-category (or other series) id. Only "QPU"
 * differs from its id; everything else (CPU/GPU/OTHER, node addresses,
 * aggregate ids like "All"/"QPUWC") passes through unchanged. Typed on
 * `string` rather than `MinerCategory` so it drops in at chart call sites
 * that key series by arbitrary ids, not just the miner-category union.
 */
export function displayLabelForCategory(id: string): string {
  return id === "QPU" ? qpuDisplayLabel() : id;
}
