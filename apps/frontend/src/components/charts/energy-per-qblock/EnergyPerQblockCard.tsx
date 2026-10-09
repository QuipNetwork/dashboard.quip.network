// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { TIME_RANGES, type TimeRange } from "@/components/charts/common/time-range";
import { ChartCard } from "@/components/layout/ChartCard";
import { formatJoules } from "@/lib/format";
import { DEFAULT_GPU_WATTS } from "@/lib/hardware-flops";
import { QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import { QPU_RESERVED_SECONDS_PER_QBLOCK } from "@quip/shared/telemetry";

import { EnergyPerQblockChart } from "./EnergyPerQblockChart";
import { useEnergyPerQblock } from "./use-energy-per-qblock";

// The measurement basis, stated once under the chart. Every number is read
// from the constant the estimate uses, so the note cannot drift from the math.
export const ENERGY_BASIS_NOTE =
  "Power is a rate in watts. Energy is power × time, shown in J, kJ, and kWh. " +
  "CPU and GPU: the reported model's vendor TDP " +
  `(${DEFAULT_GPU_WATTS} W when the GPU model is unknown) × the full block-active window, ` +
  "because a classical miner runs for as long as the qblock is open. " +
  `QPU: ${QPU_SYSTEM_WATTS / 1000} kW constant system draw (cryogenics dominate, independent of duty cycle) ` +
  `× its ${QPU_RESERVED_SECONDS_PER_QBLOCK}-second reserved window per qblock, not its chip-access time. ` +
  "All values are estimates. TDP is an upper bound for classical devices.";

/**
 * "Estimated Energy per QBlock": every participant that raced each qblock,
 * stacked by processor type, with the difficulty panel's 1H…ALL windowing.
 * The subtitle carries the in-range total so the chart answers "how much"
 * without hovering.
 */
export function EnergyPerQblockCard() {
  const [range, setRange] = useState<TimeRange>("24h");
  const { series, totalJoules, loading, error, isEmpty } = useEnergyPerQblock(range);

  return (
    <ChartCard
      title="Estimated Energy per QBlock"
      subtitle={`Every participant, stacked by processor type · ${formatJoules(totalJoules)} in range`}
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
        {isEmpty || (series.length === 0 && !loading) ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            {error ? `Mining history unavailable: ${error}` : "No qblocks in this range yet"}
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
