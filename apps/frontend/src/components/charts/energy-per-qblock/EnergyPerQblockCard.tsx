// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { TIME_RANGES, type TimeRange } from "@/components/charts/common/time-range";
import { ChartCard } from "@/components/layout/ChartCard";
import { formatJoules } from "@/lib/format";
import { estimateDeviceWatts, QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import { QPU_RESERVED_SECONDS_PER_QBLOCK } from "@quip/shared/telemetry";

import { EnergyPerQblockChart } from "./EnergyPerQblockChart";
import { useEnergyPerQblock } from "./use-energy-per-qblock";

// The measurement basis, stated once under the chart. Every number is read
// from the power estimator or time-basis constant so the note matches the math.
export const ENERGY_BASIS_NOTE =
  "Power is a rate in watts. Energy is power × time, shown in J, kJ, and kWh. " +
  "CPU, GPU, and other miners: a default draw per processor type " +
  `(CPU ${estimateDeviceWatts("CPU", null)} W, GPU ${estimateDeviceWatts("GPU", null)} W, ` +
  `other ${estimateDeviceWatts("OTHER", null)} W) × the full block-active window, ` +
  "because a classical miner runs for as long as the qblock is open. " +
  `QPU: ${QPU_SYSTEM_WATTS / 1000} kW constant system draw (cryogenics dominate, independent of duty cycle) ` +
  `× the block-active window, capped at its ${QPU_RESERVED_SECONDS_PER_QBLOCK}-second reserved window per qblock, not its chip-access time. ` +
  "All values are estimates, not measurements.";

/**
 * "Estimated Energy per QBlock": every participant that raced each qblock,
 * stacked by processor type, with the difficulty panel's 1H…ALL windowing.
 * The subtitle carries the in-range total so the chart answers "how much"
 * without hovering.
 */
export function EnergyPerQblockCard() {
  const [range, setRange] = useState<TimeRange>("24h");
  const { series, totalJoules, bucketSize, plottedQblocks, rangeQblocks, loading, error, isEmpty } =
    useEnergyPerQblock(range);
  const hasError = error !== null;
  let subtitle = "Every participant, stacked by processor type";
  if (loading) {
    subtitle += " · loading…";
  } else if (!hasError) {
    const total = formatJoules(totalJoules);
    const coverage =
      plottedQblocks > 0 && plottedQblocks < rangeQblocks
        ? `${total} across ${plottedQblocks} of ${rangeQblocks} qblocks`
        : `${total} in range`;
    subtitle += ` · ${coverage}`;
    if (bucketSize > 1) subtitle += ` · averaged over ${bucketSize}-qblock groups`;
  }

  return (
    <ChartCard
      title="Estimated Energy per QBlock"
      subtitle={subtitle}
      bodyClassName="flex h-80 flex-col"
      actions={
        <SegmentedControl
          options={TIME_RANGES}
          value={range}
          onChange={setRange}
          ariaLabel="Energy range"
        />
      }
    >
      <div className="min-h-0 flex-1">
        {hasError || isEmpty ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            {hasError
              ? `Mining history unavailable: ${error}`
              : "No energy estimates in this range yet"}
          </p>
        ) : (
          <EnergyPerQblockChart data={series} />
        )}
      </div>
      <p
        data-qa="energy-basis"
        className="mt-2 font-accent text-[11px] leading-snug text-ink-subtle"
      >
        {ENERGY_BASIS_NOTE}
      </p>
    </ChartCard>
  );
}
