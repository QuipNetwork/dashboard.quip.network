// SPDX-License-Identifier: AGPL-3.0-or-later

// Rolling estimate of "seconds until the backfill catches up", derived from
// successive readings of the remaining deficit (summed coverage gapBlocks). The
// deficit jitters as the coverage walker discovers new gaps, so the rate is the
// NET decline across a trailing window, and no estimate is offered until the
// window has enough history or when the deficit is not net-shrinking.

export interface EtaSample {
  atMs: number;
  remaining: number;
}

export const ETA_WINDOW_MS = 120_000;
export const ETA_MIN_SPAN_MS = 90_000;
const MAX_SAMPLES = 240;

/** Append `next` and drop anything older than `windowMs`. Ignores a sample
 * whose timestamp did not advance, returning the same array reference. */
export function pushEtaSample(
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

/** Seconds until the deficit reaches zero at the window's net rate, or null when
 * there isn't `minSpanMs` of history yet or the deficit isn't shrinking. */
export function estimateEtaSeconds(
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
  return Math.round(last.remaining / ratePerMs / 1000);
}
