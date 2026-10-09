// SPDX-License-Identifier: AGPL-3.0-or-later

export function formatSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/**
 * J → kJ → kWh laddering, mirroring formatDuration's "never show two units"
 * idiom. kWh is the unit readers know for electricity, and a QPU's reserved
 * window alone (12 kW × 60 s = 720 kJ) reaches it after a handful of qblocks.
 */
export function formatJoules(j: number): string {
  if (!Number.isFinite(j)) return "—";
  const abs = Math.abs(j);
  if (abs < 1_000) return `${j.toFixed(0)} J`;
  if (abs < 1_000_000) return `${(j / 1_000).toFixed(1)} kJ`;
  return `${(j / 3_600_000).toFixed(2)} kWh`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/**
 * Render an elapsed time like "3d 4h", "12h", "45m", or "30s". Designed for
 * "time on network" displays where the two largest units are the most
 * informative — we never show three.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms > 0 && ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}
