import { useUIStore, type AggregationMode } from "../../store/ui-store";
import { SERIES_COLORS } from "../../lib/colors";
import type { MinerCategory } from "../../types/telemetry";

const TYPES: MinerCategory[] = ["CPU", "GPU", "QPU"];

const MODES: { value: AggregationMode; label: string }[] = [
  { value: "byType", label: "By Type" },
  { value: "byNode", label: "By Node" },
];

export function Header() {
  const aggregationMode = useUIStore((s) => s.aggregationMode);
  const setAggregationMode = useUIStore((s) => s.setAggregationMode);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const toggleMinerType = useUIStore((s) => s.toggleMinerType);

  return (
    <header className="border-b border-brand-gray-1 bg-gradient-to-r from-brand-gray-0 via-brand-gray-1 to-brand-gray-0 px-6 py-5">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-3xl tracking-tight text-brand-gray-6">Quip</h1>
          <p className="font-accent text-sm text-brand-gray-3">Post-Quantum Mining Telemetry</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Aggregation mode toggle */}
          <div className="flex overflow-hidden rounded-lg border border-brand-gray-2">
            {MODES.map(({ value, label }) => {
              const active = aggregationMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setAggregationMode(value)}
                  className="cursor-pointer px-3 py-1.5 font-accent text-sm transition-all"
                  style={{
                    backgroundColor: active ? "#67E34720" : "transparent",
                    color: active ? "#67E347" : "#A9A9A9",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Miner type filters — only shown in byType mode */}
          {aggregationMode === "byType" && (
            <div className="flex gap-2">
              {TYPES.map((type) => {
                const active = selectedTypes.includes(type);
                return (
                  <button
                    key={type}
                    onClick={() => toggleMinerType(type)}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 font-accent text-sm transition-all"
                    style={{
                      borderColor: active ? SERIES_COLORS[type] : "#525252",
                      backgroundColor: active ? `${SERIES_COLORS[type]}15` : "transparent",
                      color: active ? SERIES_COLORS[type] : "#A9A9A9",
                    }}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        backgroundColor: active ? SERIES_COLORS[type] : "#525252",
                      }}
                    />
                    {type}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
