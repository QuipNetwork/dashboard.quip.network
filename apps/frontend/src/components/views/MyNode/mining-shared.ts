// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared parsing helpers for the MyNode mining panels (CurrentAttemptsPanel,
// MiningAttemptsModal, RecentMiningPanel). These read the miner's open-ended
// `extra` bag and u128 nanosecond timestamps, both of which arrive as
// loosely-typed JSON. Centralized here so the protocol-versioning fallbacks
// (e.g. the MR !103 `solution_meta` shape) live in one place instead of
// drifting between copy-pasted definitions.

/**
 * Coerce a loosely-typed JSON value to a finite number, or null.
 *
 * Accepts a number (when finite) or a numeric string; anything else — and
 * NaN/Infinity — yields null so callers render an em-dash rather than "NaN".
 */
export function numericField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Count of unique below-threshold samples for one iteration. Post
 * quip-protocol MR !103 this lives in `solution_meta.n_unique_below_threshold`;
 * older miner images published it as the now-removed top-level
 * `num_solutions_meeting_target`. Returns null (rendered as an em-dash)
 * when neither is present.
 */
export function meetingTargetCount(extra: Record<string, unknown>): number | null {
  const meta = extra["solution_meta"];
  if (meta && typeof meta === "object") {
    const n = numericField((meta as Record<string, unknown>)["n_unique_below_threshold"]);
    if (n !== null) return n;
  }
  return numericField(extra["num_solutions_meeting_target"]);
}

/**
 * Convert a u128 nanosecond timestamp to milliseconds, or null.
 *
 * `ts_ns` arrives as either a number or a string in the wild. The string
 * path uses BigInt so values past Number.MAX_SAFE_INTEGER divide correctly
 * before the final narrowing to a JS number. Returns null on an absent,
 * non-string/number, or unparseable value so callers can render an em-dash
 * instead of surfacing NaN.
 */
export function tsNsToMs(tsNs: unknown): number | null {
  try {
    if (typeof tsNs === "number" && Number.isFinite(tsNs)) return Math.floor(tsNs / 1_000_000);
    if (typeof tsNs === "string") {
      const ms = Number(BigInt(tsNs) / 1_000_000n);
      return Number.isFinite(ms) ? ms : null;
    }
  } catch {
    return null;
  }
  return null;
}
