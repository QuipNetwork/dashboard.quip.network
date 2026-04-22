import { useEffect } from "react";
import { Dashboard } from "./pages/Dashboard";
import { useTelemetryStore } from "./store/telemetry-store";

// Dashboard auto-refresh cadence. Indexer polls upstream every 8s; 15s keeps
// us comfortably ahead without doubling network load.
const POLL_MS = 15_000;

export default function App() {
  const fetchTelemetry = useTelemetryStore((s) => s.fetchTelemetry);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (document.visibilityState === "visible") fetchTelemetry();
    };
    const start = () => {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [fetchTelemetry]);

  return <Dashboard />;
}
