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
    <div className="relative min-h-screen bg-surface">
      <div className="pointer-events-none fixed inset-0 bg-linear-to-b from-brand-gray-2/20 via-brand-gray-0 to-brand-gray-2/15" />
      <div className="relative">
        <Header />
        <main className="mx-auto max-w-7xl p-6">
          {loading && (
            <p className="py-20 text-center font-accent text-ink-subtle">Loading telemetry…</p>
          )}
          {error && <p className="py-20 text-center font-accent text-brand-red-0">{error}</p>}
          {!loading && !error && (
            <>
              {viewMode === "my-node" && <MyNodeView />}
              {viewMode === "network" && <NetworkView />}
              {viewMode === "compute" && <ComputeAvailableView />}
              {viewMode === "chain" && <ChainView />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
