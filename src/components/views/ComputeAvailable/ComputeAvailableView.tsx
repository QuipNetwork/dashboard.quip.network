// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Compute Available view — v0.3 degraded mode.
 *
 * In v0.2 this view aggregated per-node hardware (CPUs/GPUs/QPUs, FP32
 * TFLOPS estimates, geo-located map) sourced from the `/api/telemetry`
 * response's `nodes` snapshot. v0.3 drops that surface — the substrate
 * worker is now the canonical block writer and `quip-miner-pow /api/v1/*`
 * only reports self-identity. Peer-query / chain-surface hardware
 * publication is reserved for a future version (v0.4+).
 *
 * Until then this view renders a placeholder explaining the gap so the
 * Compute tab in the header doesn't silently break.
 */
export function ComputeAvailableView() {
  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-8 backdrop-blur-xl">
      <h2 className="mb-2 font-heading text-lg text-brand-gray-5">Compute Availability</h2>
      <p className="font-accent text-sm text-brand-gray-3">
        Network-wide hardware inventory isn't published on chain yet. The dashboard only learns
        about the locally polled quip-miner via <code>/api/v1/system</code>, so it can't render an
        aggregate compute picture in v0.3.
      </p>
      <p className="mt-3 font-accent text-xs text-brand-gray-3">
        A future release will restore this view once miners publish hardware inventories on chain
        (or expose a peer-query surface).
      </p>
    </div>
  );
}
