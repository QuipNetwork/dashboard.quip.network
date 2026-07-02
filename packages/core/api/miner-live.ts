// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure parsers for the live miner-REST surfaces (`/api/v1/stats`,
// `/api/v1/status`). Shared by the indexer (polling the local miner) and the
// server's on-demand peer proxy (`/api/node/:accountId/live`) so both decode
// the miner's snake_case payloads identically. Tolerant of missing/legacy
// fields — counters default to 0, an absent `modes` block yields `{}`.

import type { MinerCategory, MinerStats, ModeBreakdown } from "@quip/shared/telemetry";

function narrowMinerType(raw: unknown): MinerCategory {
  const s = String(raw ?? "").toUpperCase();
  if (s === "CPU" || s === "GPU" || s === "QPU") return s;
  return "OTHER";
}

/** Decode `/api/v1/stats`'s `controller` sub-object into {@link MinerStats}. */
export function parseMinerStatsPayload(raw: unknown): MinerStats {
  const data = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) ?? {};
  const controller = (data["controller"] as Record<string, unknown>) ?? {};
  return {
    headsObserved: Number(controller["heads_observed"] ?? 0),
    contextsDispatched: Number(controller["contexts_dispatched"] ?? 0),
    resultsReceived: Number(controller["results_received"] ?? 0),
    proofsSubmitted: Number(controller["proofs_submitted"] ?? 0),
    staleDrops: Number(controller["stale_drops"] ?? 0),
    submissionErrors: Number(controller["submission_errors"] ?? 0),
    duplicateResultDrops: Number(controller["duplicate_result_drops"] ?? 0),
  };
}

/**
 * Decode the `modes` field returned by `/api/v1/status`. Tolerates the legacy
 * shape where the miner emits no `modes` (returns `{}`) and the aggregator
 * shape `{<mode>: {controller: {...}, miners: [...]}}`.
 */
export function parseStatusModes(raw: unknown): Record<string, ModeBreakdown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModeBreakdown> = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const ctrl = (v["controller"] as Record<string, unknown>) ?? {};
    const minersRaw = Array.isArray(v["miners"])
      ? (v["miners"] as Array<Record<string, unknown>>)
      : [];
    out[mode] = {
      headsObserved: Number(ctrl["heads_observed"] ?? 0),
      contextsDispatched: Number(ctrl["contexts_dispatched"] ?? 0),
      resultsReceived: Number(ctrl["results_received"] ?? 0),
      proofsSubmitted: Number(ctrl["proofs_submitted"] ?? 0),
      staleDrops: Number(ctrl["stale_drops"] ?? 0),
      submissionErrors: Number(ctrl["submission_errors"] ?? 0),
      duplicateResultDrops: Number(ctrl["duplicate_result_drops"] ?? 0),
      miners: minersRaw.map((m) => ({
        id: String(m["id"] ?? ""),
        type: narrowMinerType(m["type"]),
      })),
    };
  }
  return out;
}

/**
 * The first miner id a node declares on `/api/v1/status` — the handle the
 * attempts endpoint keys dispatch directories on. Null when none is declared.
 */
export function parseStatusPrimaryMinerId(raw: unknown): string | null {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const miners = data["miners"];
  if (!Array.isArray(miners) || miners.length === 0) return null;
  const id = (miners[0] as Record<string, unknown>)["id"];
  const s = id == null ? "" : String(id);
  return s.length > 0 ? s : null;
}

export { narrowMinerType };
