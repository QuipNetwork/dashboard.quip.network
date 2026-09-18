import { lazy, Suspense } from "react";

import { Header } from "@/components/layout/Header";
import { ChainView } from "@/components/views/Chain/ChainView";
import { MyNodeView } from "@/components/views/MyNode/MyNodeView";
import { NodeView } from "@/components/views/Node/NodeView";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

// Network and Compute own nivo and react-simple-maps. Keep them off the default My Node graph.
const NetworkView = lazy(() =>
  import("@/components/views/Network/NetworkView").then((module) => ({
    default: module.NetworkView,
  })),
);
const ComputeAvailableView = lazy(() =>
  import("@/components/views/ComputeAvailable/ComputeAvailableView").then((module) => ({
    default: module.ComputeAvailableView,
  })),
);

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
              <Suspense fallback={<p role="status">Loading view…</p>}>
                {viewMode === "my-node" && <MyNodeView />}
                {viewMode === "network" && <NetworkView />}
                {viewMode === "compute" && <ComputeAvailableView />}
                {viewMode === "chain" && <ChainView />}
                {viewMode === "node" && <NodeView />}
              </Suspense>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
