import { useTelemetryStore } from "../../store/telemetry-store";
import { useUIStore, type AggregationMode, type ViewMode } from "../../store/ui-store";
import { SERIES_COLORS } from "../../lib/colors";
import type { MinerCategory } from "../../types/telemetry";
import { BabeEpochProgress } from "./BabeEpochProgress";
import { CurrentBlockIndicator } from "./CurrentBlockIndicator";
import { SyncIndicator } from "./SyncIndicator";

const TYPES: MinerCategory[] = ["CPU", "GPU", "QPU"];

const MODES: { value: AggregationMode; label: string }[] = [
  { value: "byType", label: "By Type" },
  { value: "byNode", label: "By Node" },
];

const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "my-node", label: "My Node" },
  { value: "network", label: "Network" },
  { value: "compute", label: "Compute" },
  { value: "chain", label: "Chain" },
];

export function Header() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const aggregationMode = useUIStore((s) => s.aggregationMode);
  const setAggregationMode = useUIStore((s) => s.setAggregationMode);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const toggleMinerType = useUIStore((s) => s.toggleMinerType);
  const hasChainData = useTelemetryStore(
    (s) => s.chainMiners.length > 0 || s.babeAuthorities.length > 0 || s.chainHead !== null,
  );

  const showAggregation = viewMode === "network" || viewMode === "compute";
  const showTypeFilters = viewMode === "network" && aggregationMode === "byType";

  // Chain tab is hidden when the substrate worker is unconfigured (or
  // hasn't produced any data yet). Once any of chain_head / chainMiners
  // / babeAuthorities lands, the tab appears. REST-only deployments
  // never see it — matches the substrate health dot's hide policy.
  const views = VIEWS.filter((v) => v.value !== "chain" || hasChainData);

  return (
    <header className="border-b border-brand-gray-1 bg-gradient-to-r from-brand-gray-0 via-brand-gray-1 to-brand-gray-0 px-6 py-5">
      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
        {/* Left: sync indicator (always) + aggregation toggle (Network + Compute only). */}
        <div className="flex flex-col items-center gap-2 justify-self-center sm:items-start sm:justify-self-start">
          <SyncIndicator />
          {/* BabeEpochProgress hides itself when substrate is unconfigured;
              free to include unconditionally. */}
          <BabeEpochProgress />
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

        {/* Center: primary view toggle + live mining block indicator.
            `flex flex-col items-center` so the pill toggle sizes to its
            buttons regardless of how long the indicator text below is —
            without it, the p below stretches the column and drags the
            pill width with it. */}
        <div className="flex flex-col items-center justify-self-center">
          <div className="flex overflow-hidden rounded-lg border border-brand-gray-2">
            {views.map(({ value, label }) => {
              const active = viewMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setViewMode(value)}
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
          <CurrentBlockIndicator />
        </div>

        {/* Right column intentionally empty — preserves the 1fr_auto_1fr grid
            so the center pill stays centered. */}
        <div />
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
