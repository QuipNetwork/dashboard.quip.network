// SPDX-License-Identifier: AGPL-3.0-or-later

/** Compact human ETA from milliseconds: "<1m", "~4m", "~1h", "~1h 30m". */
export function formatEta(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}
