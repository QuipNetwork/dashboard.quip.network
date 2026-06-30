// SPDX-License-Identifier: AGPL-3.0-or-later
// energy (units, negative) -> per-mille position on the chain's linear energy
// curve: position = -energy * 1000 / K. Null when K is unknown (pre-v0.2 / no
// default topology), so callers fall back to showing raw energy.

import { useTelemetryStore } from "@/store/telemetry-store";

export function energyToCurveMille(energy: number, k: number | null): number | null {
  if (k == null || !(k > 0)) return null;
  return Math.round((-energy * 1000) / k);
}

// Tick label: "747‰ (−14.5)" when K is known, else "−14.5".
export function formatDifficultyTick(energy: number, k: number | null): string {
  const e = energy.toFixed(1);
  const m = energyToCurveMille(energy, k);
  return m == null ? e : `${m}‰ (${e})`;
}

/**
 * The difficulty-curve constant K of the current default topology, or null
 * when the chain hasn't exposed it (pre-v0.2 / no default topology yet).
 * Charts pass this to {@link formatDifficultyTick} so a missing K degrades to
 * showing the raw energy instead of a per-mille position.
 */
export function useDifficultyCurveK(): number | null {
  return (
    useTelemetryStore((s) => s.mineableTopologies).find((t) => t.isDefault)?.curveConstant ?? null
  );
}
