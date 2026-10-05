export function DashboardIntro() {
  return (
    <section aria-labelledby="dashboard-title" className="mx-auto max-w-7xl px-6 pt-6 pb-3">
      <h1 id="dashboard-title" className="font-heading text-2xl text-ink-strong">
        Quip Mining Telemetry Dashboard
      </h1>
      <p className="mt-2 max-w-4xl text-sm text-ink-subtle">
        Track mining on the Quip network. See block counts and mining times for CPU, GPU, and QPU
        miners. Compare compute use by node or hardware type. Open a node to see its details, or use
        the Chain view to check chain data. Enable JavaScript to load live charts and data from the
        dashboard API.
      </p>
    </section>
  );
}
