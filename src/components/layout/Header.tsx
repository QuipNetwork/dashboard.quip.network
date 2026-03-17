import { useTelemetryStore } from "../../store/telemetry-store";
import { SERIES_COLORS } from "../../lib/colors";
import type { MinerCategory } from "../../types/telemetry";

const TYPES: MinerCategory[] = ["CPU", "GPU", "QPU"];

export function Header() {
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);
  const toggleMinerType = useTelemetryStore((s) => s.toggleMinerType);

  return (
    <header className="border-b border-brand-gray-1 bg-gradient-to-r from-brand-gray-0 via-brand-gray-1 to-brand-gray-0 px-6 py-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl tracking-tight text-brand-gray-6">Quip</h1>
          <p className="font-accent text-sm text-brand-gray-3">Post-Quantum Mining Telemetry</p>
        </div>
        <div className="flex gap-2">
          {TYPES.map((type) => {
            const active = selectedTypes.includes(type);
            return (
              <button
                key={type}
                onClick={() => toggleMinerType(type)}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 font-accent text-sm transition-all"
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
      </div>
    </header>
  );
}
