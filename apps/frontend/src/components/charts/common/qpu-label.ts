// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Display-only QPU label. On ordinary by-type/by-node surfaces the QPU
// series renders under the plain "QPU" label, same as every other miner
// category — the budget-qualified variant ("QPU20m") reads as a stat, not a
// name, everywhere it isn't specifically about the budget split.
//
// The one place a budget-qualified label IS meaningful is the "Normalized"
// aggregation mode (see win-rate-by-difficulty and mining-time's
// `buildNormalizedComposition`/`buildNormalizedSeries`), which splits QPU
// into two participation regimes ("QPU20m" observed, "QPU100%"
// extrapolated to full-time). That split is a property of the reference
// composition model itself — normalized-composition.ts emits its own fixed
// "QPU20m"/"QPU100%" labels directly on those two series and never calls
// into this module. The `mode` parameter here exists for API symmetry (and
// for any live-budget-qualified label a future normalized-mode consumer of
// a single QPU id might need); it is not currently exercised by any chart.
//
// The budget itself lives on-chain as `NodeMinerEntry.dailyBudget`
// (packages/shared/telemetry/node.ts) and DOES reach the frontend today —
// `node_descriptors.descriptor` jsonb is round-tripped verbatim (no field
// whitelist like the observability parser has), so
// `descriptors[].descriptor.miners[*].dailyBudget` is already sitting in the
// telemetry store. `latestAdvertisedQpuBudgetMin` extracts it; the
// budget-qualified label falls back to `QPU_DAILY_BUDGET_MIN`
// (normalized-composition.ts) when nothing parses.
//
// Deliberate divergence: the normalized-composition model's
// `QPU_DAILY_BUDGET_MIN`/`QPU_BUDGET_FRACTION` stay FIXED at 20m — that
// model defines a reference composition at a fixed budget, and letting it
// track the live value would change chart semantics, not just a label.

import { useMemo } from "react";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { NodeDescriptorRecord } from "@quip/shared/telemetry";

import { QPU_DAILY_BUDGET_MIN } from "./normalized-composition";

// Tolerant parse of the on-chain `dailyBudget` string. The format is
// self-reported and unaudited, so only the formats we've actually seen are
// accepted: plain minutes ("20"), "20m", "20min" (case-insensitive,
// optional surrounding whitespace). Anything else — missing, non-numeric,
// an unrecognized unit, zero/negative — returns null rather than guessing.
const DAILY_BUDGET_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(m|min)?\s*$/i;

function parseDailyBudgetMinutes(raw: string | undefined): number | null {
  if (raw == null) return null;
  const match = DAILY_BUDGET_PATTERN.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Scan every QPU-kind miner entry across `descriptors` for the last
 * advertised `dailyBudget`, in minutes. Descriptors carry `blockTimestamp`
 * (the chain block the descriptor was last updated), so entries are
 * considered most-recently-updated first; the first one that parses to a
 * valid budget wins — a stale/garbled newest advertisement doesn't blank
 * out an otherwise healthy older one. Returns null when no descriptor
 * advertises a parseable QPU budget.
 */
export function latestAdvertisedQpuBudgetMin(
  descriptors: ReadonlyArray<NodeDescriptorRecord>,
): number | null {
  const byRecency = [...descriptors].sort((a, b) => b.blockTimestamp - a.blockTimestamp);
  for (const record of byRecency) {
    for (const entry of Object.values(record.descriptor.miners ?? {})) {
      if (entry.kind !== "QPU") continue;
      const parsed = parseDailyBudgetMinutes(entry.dailyBudget);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

/**
 * "standard" (the default everywhere) renders the plain "QPU" name, same as
 * every other miner category. "normalized" renders the budget-qualified
 * "QPU<N>m" — see the module header for why that split only matters there,
 * and why no current chart actually passes it.
 */
export type QpuLabelMode = "standard" | "normalized";

/**
 * The QPU series label. In "standard" mode (the default) this is just
 * "QPU". In "normalized" mode it's budget-qualified — "QPU20m" — using
 * `budgetMin` when it's a finite positive number, else falling back to
 * `QPU_DAILY_BUDGET_MIN`.
 */
export function qpuDisplayLabel(
  budgetMin?: number | null,
  mode: QpuLabelMode = "standard",
): string {
  if (mode !== "normalized") return "QPU";
  const min =
    typeof budgetMin === "number" && Number.isFinite(budgetMin) && budgetMin > 0
      ? budgetMin
      : QPU_DAILY_BUDGET_MIN;
  return `QPU${min}m`;
}

/**
 * Display label for a miner-category (or other series) id. Only "QPU"
 * differs from its id; everything else (CPU/GPU/OTHER, node addresses,
 * aggregate ids like "All"/"QPUWC") passes through unchanged. Typed on
 * `string` rather than `MinerCategory` so it drops in at chart call sites
 * that key series by arbitrary ids, not just the miner-category union.
 */
export function displayLabelForCategory(id: string, mode: QpuLabelMode = "standard"): string {
  return id === "QPU" ? qpuDisplayLabel(undefined, mode) : id;
}

/**
 * The QPU series label for the given `mode` (defaults to "standard", i.e.
 * plain "QPU"). In "normalized" mode this tracks the last advertised QPU
 * dailyBudget from the telemetry store's descriptors, falling back to
 * "QPU20m" when none parses. Memoized on the descriptors array reference,
 * which the store replaces wholesale on each telemetry fetch (see
 * telemetry-store.ts).
 */
export function useQpuDisplayLabel(mode: QpuLabelMode = "standard"): string {
  const descriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const budgetMin = useMemo(() => latestAdvertisedQpuBudgetMin(descriptors), [descriptors]);
  return qpuDisplayLabel(budgetMin, mode);
}

/**
 * Bind a live `qpuLabel` (from `useQpuDisplayLabel()`) into a
 * `displayLabelForCategory`-shaped `(id: string) => string` resolver, for
 * chart call sites that need a plain callback (nivo axis/tooltip/legend
 * props) rather than a hook call at every use site. Resolve `qpuLabel` once
 * at the component layer, then thread it through this helper — keeps the
 * callback itself pure.
 */
export function labelForCategoryWith(qpuLabel: string): (id: string) => string {
  return (id) => (id === "QPU" ? qpuLabel : displayLabelForCategory(id));
}
