// SPDX-License-Identifier: AGPL-3.0-or-later

// Rolling estimate of "time until the backfill catches up", derived client-side
// from successive readings of the remaining deficit (the indexer publishes no
// rate). The deficit jitters — the coverage walker can discover new gaps between
// polls — so the rate is taken as the NET decline across a trailing window
// rather than a single poll-to-poll delta, and no ETA is shown until the window
// has enough history or when the deficit is not net-shrinking.

export interface EtaSample {
  atMs: number;
  remaining: number;
}

// Trailing window the rate is measured over, and the minimum history required
// before an estimate is offered.
export const ETA_WINDOW_MS = 120_000;
export const ETA_MIN_SPAN_MS = 90_000;
// Safety cap so a fallback clock that advances every render can't grow the
// buffer unbounded.
const MAX_SAMPLES = 240;

/**
 * Append `next` and drop anything older than `windowMs` behind it. Ignores a
 * sample whose timestamp did not advance (dedup across re-renders / a paused
 * server clock), returning the same array reference so callers can store it
 * without churn.
 */
export function pushSample(
  samples: EtaSample[],
  next: EtaSample,
  windowMs: number = ETA_WINDOW_MS,
): EtaSample[] {
  const last = samples[samples.length - 1];
  if (last && next.atMs <= last.atMs) return samples;
  const cutoff = next.atMs - windowMs;
  const trimmed = samples.filter((s) => s.atMs >= cutoff);
  trimmed.push(next);
  return trimmed.length > MAX_SAMPLES ? trimmed.slice(trimmed.length - MAX_SAMPLES) : trimmed;
}

/**
 * Milliseconds until the deficit reaches zero at the window's net rate, or null
 * when there isn't `minSpanMs` of history yet or the deficit isn't shrinking.
 */
export function estimateEtaMs(
  samples: EtaSample[],
  minSpanMs: number = ETA_MIN_SPAN_MS,
): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const spanMs = last.atMs - first.atMs;
  if (spanMs < minSpanMs) return null;
  const closed = first.remaining - last.remaining;
  if (closed <= 0) return null;
  const ratePerMs = closed / spanMs;
  return last.remaining / ratePerMs;
}

/** Compact human ETA: "<1m", "~4m", "~1h", "~1h 30m". */
export function formatEta(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}
