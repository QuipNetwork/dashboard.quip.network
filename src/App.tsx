import { useEffect } from "react";
import { Dashboard } from "./components/layout/Dashboard";
import { useTelemetryStore } from "./store/telemetry-store";

export default function App() {
  const fetchTelemetry = useTelemetryStore((s) => s.fetchTelemetry);

  useEffect(() => {
    fetchTelemetry();
  }, [fetchTelemetry]);

  return <Dashboard />;
}
