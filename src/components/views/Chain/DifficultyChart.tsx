// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveLine } from "@nivo/line";

import { nivoTheme } from "@/theme/nivo-theme";
import { useTelemetryStore } from "@/store/telemetry-store";

/**
 * Time-series of the chain's target energy threshold from
 * `quantum_pow.Difficulty`. min_diversity / min_solutions are intentionally
 * not plotted here — they're small integers that share no scale with
 * energy and surface in the Current Difficulty tile + MyNode card instead.
 *
 * Hides itself when fewer than 2 snapshots exist (chart needs at least
 * one segment to draw a line).
 */
export function DifficultyChart() {
  const recent = useTelemetryStore((s) => s.recentDifficulty);
  if (recent.length < 2) return null;

  // recentDifficulty arrives newest-first; reverse for ascending X so the
  // line draws left-to-right naturally. Use the substrate block number as
  // the X anchor — meaningful units, monotonic, dense enough for a
  // ~hundred-point timeline.
  const ascending = [...recent].reverse();
  const data = [
    {
      id: "Target energy",
      data: ascending.map((d) => ({
        x: Number(d.observedAtBlock),
        y: d.difficultyEnergy,
      })),
    },
  ];

  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-4 backdrop-blur-xl">
      <header className="mb-2">
        <h3 className="font-heading text-base text-brand-gray-5">Difficulty over time</h3>
        <p className="font-accent text-xs text-brand-gray-3">
          Target energy ceiling (proofs must satisfy energy ≤ threshold). Last {recent.length}{" "}
          snapshots from <code>quantum_pow.Difficulty</code>.
        </p>
      </header>
      <div data-qa="chart-difficulty-history" style={{ width: "100%", height: 240 }}>
        <ResponsiveLine
          data={data}
          theme={nivoTheme}
          margin={{ top: 10, right: 30, bottom: 40, left: 60 }}
          xScale={{ type: "linear" }}
          yScale={{ type: "linear", min: "auto", max: "auto" }}
          curve="monotoneX"
          enablePoints={false}
          lineWidth={2}
          axisBottom={{
            legend: "Substrate block",
            legendOffset: 32,
            legendPosition: "middle",
          }}
          axisLeft={{
            legend: "Target energy",
            legendOffset: -50,
            legendPosition: "middle",
          }}
          useMesh
          enableCrosshair
        />
      </div>
    </div>
  );
}
