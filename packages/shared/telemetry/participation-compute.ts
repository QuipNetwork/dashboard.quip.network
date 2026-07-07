// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Participant-level compute model: turns raw qblock-participation rows (every
// node that declared it raced a qblock, across all device kinds) into
// per-category device-access + mining totals. The winner-only
// `resolveDeviceAccessTime` (frontend) answers "how much compute is behind the
// WINNING proof"; this answers "how much compute did the WHOLE field spend",
// which the Total-Compute pie and Mining-per-QBlock charts need.

import type { MinerCategory } from "./miner";

// QPU wall-clock is not device-access time: a D-Wave submission's real chip
// access is ~0.0613s (h0 phaseB access model, r=112: 34.6ms programming +
// 112·0.238ms readout), but cloud round-trip dominates the wall clock. In the
// h0 tts dataset the QPU's wall-clock TTS is a DIFFICULTY-INVARIANT multiple of
// its access TTS (both scale as 1/p_success): measured 14.98x dedicated /
// 74.89x contended. So a QPU node racing a qblock for `wall` seconds
// accumulates ~ `wall / RATIO` seconds of true chip access. Default to the
// contended ratio — production nodes share the D-Wave Leap quota (h0 notion
// §3.2: the 30-min/day quota is the operative constraint), so back-to-back
// dedicated submission is not the realistic regime.
export const QPU_ACCESS_TO_WALL_RATIO = 74.89;

/** Map a raw on-chain `MinerKind` variant name to a dashboard `MinerCategory`. */
export function minerKindToCategory(kind: string): MinerCategory {
  if (kind === "Cpu") return "CPU";
  if (kind === "Gpu") return "GPU";
  if (kind.startsWith("Qpu")) return "QPU";
  return "OTHER";
}

export interface ParticipantAccessInput {
  category: MinerCategory;
  // The qblock's block-active wall clock (`BlockRecord.miningTime`), seconds.
  miningSeconds: number;
  // Exact self-reported QPU access time from miner telemetry
  // (`mining_submissions.qpu_access_time_us`), µs. Present only for nodes we
  // poll (the operator's own); null/0/undefined everywhere else.
  exactQpuAccessUs?: number | null;
}

export interface ResolvedParticipantAccess {
  deviceAccessSeconds: number;
  // False only when a real self-reported figure was used (exact QPU telemetry).
  // CPU/GPU/OTHER and estimated QPU are all `true` — the field is a whole-block
  // certainty flag, matching `resolveDeviceAccessTime`.
  estimated: boolean;
}

/**
 * Device-access seconds one participant contributed to a qblock.
 *
 * CPU/GPU/OTHER: charged the full block-active window — a racing miner runs
 * continuously for as long as the qblock is open, so its device time is the
 * window itself. QPU: exact telemetry when we have it (self node), else the
 * wall-window estimate `miningSeconds / QPU_ACCESS_TO_WALL_RATIO`.
 */
export function resolveParticipantAccessTime(
  input: ParticipantAccessInput,
): ResolvedParticipantAccess {
  if (input.category === "QPU") {
    const us = input.exactQpuAccessUs;
    if (us != null && Number.isFinite(us) && us > 0) {
      return { deviceAccessSeconds: us / 1_000_000, estimated: false };
    }
    return {
      deviceAccessSeconds: input.miningSeconds / QPU_ACCESS_TO_WALL_RATIO,
      estimated: true,
    };
  }
  return { deviceAccessSeconds: input.miningSeconds, estimated: true };
}

/**
 * One joined participation fact: a participant's declared `kind` on a qblock,
 * plus that qblock's `miningSeconds` (from `blocks`) and the participant's
 * exact QPU access (from `mining_submissions`, when self-polled). The DB layer
 * produces these; the aggregators below reduce them.
 */
export interface ParticipationComputeRow {
  qblockId: string;
  account: string;
  kind: string;
  miningSeconds: number;
  exactQpuAccessUs: number | null;
}

export interface CategoryCompute {
  category: MinerCategory;
  participantCount: number;
  // Σ per-participant device-access seconds (QPU access-corrected).
  deviceAccessSeconds: number;
  // Σ per-participant raw block-active wall clock — recorded distinctly from
  // deviceAccessSeconds so QPU's wall vs. chip-time gap stays visible.
  miningSeconds: number;
  // True when any contribution to this category was estimated.
  estimated: boolean;
}

function foldRow(acc: Map<MinerCategory, CategoryCompute>, r: ParticipationComputeRow): void {
  const category = minerKindToCategory(r.kind);
  const { deviceAccessSeconds, estimated } = resolveParticipantAccessTime({
    category,
    miningSeconds: r.miningSeconds,
    exactQpuAccessUs: r.exactQpuAccessUs,
  });
  const cur = acc.get(category) ?? {
    category,
    participantCount: 0,
    deviceAccessSeconds: 0,
    miningSeconds: 0,
    estimated: false,
  };
  cur.participantCount += 1;
  cur.deviceAccessSeconds += deviceAccessSeconds;
  cur.miningSeconds += r.miningSeconds;
  cur.estimated = cur.estimated || estimated;
  acc.set(category, cur);
}

/** Network/window totals per category — the Total-Compute pie's data. */
export function aggregateParticipationByCategory(
  rows: readonly ParticipationComputeRow[],
): CategoryCompute[] {
  const acc = new Map<MinerCategory, CategoryCompute>();
  for (const r of rows) foldRow(acc, r);
  return [...acc.values()];
}

/** Per-qblock, per-category totals — the Mining-per-QBlock chart's data. */
export function aggregateParticipationByQblock(
  rows: readonly ParticipationComputeRow[],
): Map<string, CategoryCompute[]> {
  const byQblock = new Map<string, Map<MinerCategory, CategoryCompute>>();
  for (const r of rows) {
    const acc = byQblock.get(r.qblockId) ?? new Map<MinerCategory, CategoryCompute>();
    foldRow(acc, r);
    byQblock.set(r.qblockId, acc);
  }
  return new Map([...byQblock].map(([q, acc]) => [q, [...acc.values()]]));
}
