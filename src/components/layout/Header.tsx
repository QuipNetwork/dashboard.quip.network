import { useUIStore, type AggregationMode, type ViewMode } from "../../store/ui-store";
import { SERIES_COLORS } from "../../lib/colors";
import type { MinerCategory } from "../../types/telemetry";
import { CurrentBlockIndicator } from "./CurrentBlockIndicator";
import { EpochSelector } from "./EpochSelector";

const TYPES: MinerCategory[] = ["CPU", "GPU", "QPU"];

const MODES: { value: AggregationMode; label: string }[] = [
  { value: "byType", label: "By Type" },
  { value: "byNode", label: "By Node" },
];

const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "my-node", label: "My Node" },
  { value: "network", label: "Network" },
  { value: "compute", label: "Compute" },
];

export function Header() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const aggregationMode = useUIStore((s) => s.aggregationMode);
  const setAggregationMode = useUIStore((s) => s.setAggregationMode);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const toggleMinerType = useUIStore((s) => s.toggleMinerType);

  const showAggregation = viewMode === "network" || viewMode === "compute";
  const showTypeFilters = viewMode === "network" && aggregationMode === "byType";

  return (
    <header className="border-b border-brand-gray-1 bg-gradient-to-r from-brand-gray-0 via-brand-gray-1 to-brand-gray-0 px-6 py-5">
      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-3">
        {/* Left: aggregation toggle (Network + Compute) */}
        <div className="justify-self-center sm:justify-self-start">
          {showAggregation && (
            <div className="flex overflow-hidden rounded-lg border border-brand-gray-2">
              {MODES.map(({ value, label }) => {
                const active = aggregationMode === value;
                return (
                  <button
                    key={value}
                    onClick={() => setAggregationMode(value)}
                    className="cursor-pointer px-3 py-1.5 font-accent text-sm transition-all"
                    style={{
                      backgroundColor: active ? "#4CE0FF20" : "transparent",
                      color: active ? "#4CE0FF" : "#A9A9A9",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Center: primary view toggle + live mining block indicator */}
        <div className="justify-self-center">
          <div className="flex overflow-hidden rounded-lg border border-brand-gray-2">
            {VIEWS.map(({ value, label }) => {
              const active = viewMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setViewMode(value)}
                  // Fixed min-width keeps "Compute" from looking visually
                  // wider than "Network" / "My Node" — the 'm' glyph would
                  // otherwise push the third button out by a few pixels.
                  className="min-w-24 cursor-pointer px-3 py-1.5 text-center font-accent text-sm transition-all"
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
          <CurrentBlockIndicator />
        </div>

        {/* Right: epoch filter */}
        <div className="justify-self-center sm:justify-self-end">
          <EpochSelector />
        </div>
      </div>

      {/* Secondary row: per-type filters (Network + By Type only) */}
      {showTypeFilters && (
        <div className="mt-3 flex flex-wrap justify-center gap-2 border-t border-brand-gray-1 pt-3 sm:justify-start">
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
    </header>
  );
}
