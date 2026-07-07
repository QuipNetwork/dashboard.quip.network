// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import type { MinerCategory } from "@quip/shared/telemetry";
import { aggregateParticipationByCategory } from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";

// QPU's true device-access time is real D-Wave anneal+readout seconds, not
// comparable in magnitude to a CPU/GPU wall-clock total — a healthy network
// can have a QPU total that's genuinely <1% of the CPU total. Floor QPU's
// *rendered* slice value to this fraction of the largest slice so a
// nonzero-but-tiny total still reads as a wedge instead of vanishing next to
// CPU/GPU. Labels/tooltips always report the true `compute` value, never this
// floor — see `displayCompute`/`floored` below.
const MIN_VISIBLE_FRACTION = 0.03;

// Stable slice order so the pie renders deterministically regardless of the
// order participation rows arrive in.
const CATEGORY_ORDER: readonly MinerCategory[] = ["CPU", "GPU", "QPU", "OTHER"];

export interface ComputeUsedEntry {
  [key: string]: string | number | boolean;
  minerType: string;
  /** True total seconds of device access time this slice accounts for. */
  compute: number;
  /**
   * Value to render as the slice's arc. Equal to `compute` unless floored for
   * visibility (QPU only, see `MIN_VISIBLE_FRACTION`) — labels/tooltips should
   * read `compute`, not this field.
   */
  displayCompute: number;
  /** True when `displayCompute` was raised above the true `compute` to stay visible. */
  floored: boolean;
  /**
   * True when any participant contributing to this slice used an estimated
   * (rather than self-reported) access time. CPU/GPU/OTHER and estimated QPU
   * are all estimated; only exact QPU telemetry clears it. A single estimated
   * contribution taints the whole slice's certainty, so this is a
   * wholly-or-partly flag, not a fraction.
   */
  estimated: boolean;
}

/**
 * Total device access time accounted for, in seconds, grouped by processor
 * category — the "Total Compute Used" pie's data.
 *
 * Sourced from the participant-level aggregate
 * (`aggregateParticipationByCategory`): every node that raced a qblock across
 * every device kind, NOT just the winning proof. CPU/GPU/OTHER are charged the
 * full block-active window; QPU uses exact self-reported chip access when
 * present, else the wall/ratio estimate (see participation-compute.ts). QPU's
 * tiny-but-nonzero total is floored to a visible slice via
 * `MIN_VISIBLE_FRACTION` while its label keeps the true seconds.
 */
export function useComputeUsed(): ComputeUsedEntry[] {
  const participationCompute = useTelemetryStore((s) => s.participationCompute);

  return useMemo(() => {
    const byCategory = aggregateParticipationByCategory(participationCompute);
    const rows = [...byCategory]
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
      .map((c) => ({
        minerType: c.category,
        compute: c.deviceAccessSeconds,
        estimated: c.estimated,
      }));

    const maxCompute = Math.max(0, ...rows.map((r) => r.compute));
    const floor = maxCompute * MIN_VISIBLE_FRACTION;

    return rows.map((r) => {
      const floored = r.minerType === "QPU" && r.compute > 0 && r.compute < floor;
      return {
        ...r,
        displayCompute: floored ? floor : r.compute,
        floored,
      };
    });
  }, [participationCompute]);
}
