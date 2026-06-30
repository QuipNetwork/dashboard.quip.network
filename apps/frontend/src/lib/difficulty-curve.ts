// SPDX-License-Identifier: AGPL-3.0-or-later
// energy (units, negative) -> per-mille position on the chain's linear energy
// curve: position = -energy * 1000 / K. Null when K is unknown (pre-v0.2 / no
// default topology), so callers fall back to showing raw energy.

import { useTelemetryStore } from "@/store/telemetry-store";

export function energyToCurveMille(energy: number, k: number | null): number | null {
  if (k == null || !(k > 0)) return null;
  return Math.round((-energy * 1000) / k);
}

// Tick label: "747‰ (−14559)" when K is known, else "−14559". Energies are
// large integers (units), so no decimal place.
export function formatDifficultyTick(energy: number, k: number | null): string {
  const e = String(Math.round(energy));
  const m = energyToCurveMille(energy, k);
  return m == null ? e : `${m}‰ (${e})`;
}

// Compact tick for dense axes (e.g. the histogram): just the per-mille
// position, "747‰", or the rounded energy when K is unknown. The full energy
// belongs in the tooltip there, since "‰ (energy)" is too wide to fit.
export function formatDifficultyTickShort(energy: number, k: number | null): string {
  const m = energyToCurveMille(energy, k);
  return m == null ? String(Math.round(energy)) : `${m}‰`;
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
