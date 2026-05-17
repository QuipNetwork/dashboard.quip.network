// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTelemetryStore } from "../../store/telemetry-store";

/**
 * Substrate BABE epoch progress pill. Distinct from the PoW `epoch` concept
 * the EpochSelector exposes — BABE epochs are the substrate chain's
 * consensus rotation (~2400 slots / ~4h on quip-protocol-rs spec 101).
 *
 * Hides itself entirely when no `babeEpoch` is in the store (substrate
 * worker unconfigured or hasn't completed its first poll yet). REST-only
 * deployments never see this surface.
 */
export function BabeEpochProgress() {
  const babeEpoch = useTelemetryStore((s) => s.babeEpoch);
  if (!babeEpoch) return null;

  const pct =
    babeEpoch.slotsPerEpoch > 0
      ? Math.min(100, Math.round((babeEpoch.currentSlotInEpoch / babeEpoch.slotsPerEpoch) * 100))
      : 0;

  return (
    <div
      className="flex items-center gap-2 font-accent text-[11px] text-brand-gray-3"
      title={`Substrate BABE epoch — slot ${babeEpoch.currentSlotInEpoch} of ${babeEpoch.slotsPerEpoch}. Not the same as the PoW epoch shown in the selector.`}
    >
      <span>BABE #{babeEpoch.epochIndex}</span>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-brand-gray-1">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, backgroundColor: "#4CE0FF" }}
        />
      </div>
      <span className="tabular-nums">{pct}%</span>
      <span aria-hidden>·</span>
      <span>
        {babeEpoch.authorityCount} authorit{babeEpoch.authorityCount === 1 ? "y" : "ies"}
      </span>
    </div>
  );
}
