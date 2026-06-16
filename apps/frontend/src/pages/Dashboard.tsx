import { Header } from "@/components/layout/Header";
import { ChainView } from "@/components/views/Chain/ChainView";
import { ComputeAvailableView } from "@/components/views/ComputeAvailable/ComputeAvailableView";
import { MyNodeView } from "@/components/views/MyNode/MyNodeView";
import { NetworkView } from "@/components/views/Network/NetworkView";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

export function Dashboard() {
  const loading = useTelemetryStore((s) => s.loading);
  const error = useTelemetryStore((s) => s.error);
  const viewMode = useUIStore((s) => s.viewMode);

  return (
    <div className="min-h-screen bg-surface">
      <div>
        <Header />
        <main className="mx-auto max-w-7xl p-6">
          {loading && (
            <p className="py-20 text-center font-accent text-ink-subtle">Loading telemetry…</p>
          )}
          {error && <p className="py-20 text-center font-accent text-coral">{error}</p>}
          {!loading && !error && (
            <div className="flex flex-col gap-5">
              {viewMode === "my-node" && <MyNodeView />}
              {viewMode === "network" && <NetworkView />}
              {viewMode === "compute" && <ComputeAvailableView />}
              {viewMode === "chain" && <ChainView />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
