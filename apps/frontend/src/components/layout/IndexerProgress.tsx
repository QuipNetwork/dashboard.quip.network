// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useRef } from "react";

import { estimateEtaMs, formatEta, pushSample, type EtaSample } from "@/lib/indexer-eta";
import { computeIndexerProgress } from "@/lib/indexer-progress";
import { selectServerNowMs, useTelemetryStore } from "@/store/telemetry-store";

const STAGE_LABEL = {
  "node-sync": "Node sync",
  indexing: "Indexing",
} as const;

// Progress line under "Connected Miner": validator node sync, then dashboard
// backfill, then nothing once live. Stage/threshold logic lives in the pure
// helper; the backfill ETA is derived here from the deficit's decline over a
// rolling window (see lib/indexer-eta).
export function IndexerProgress() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const nowMs = useTelemetryStore(selectServerNowMs);
  // Rolling deficit samples for the ETA. pushSample dedups by timestamp, so
  // mutating during render is idempotent across re-renders.
  const samplesRef = useRef<EtaSample[]>([]);
  const progress = useMemo(() => computeIndexerProgress(indexer, nowMs), [indexer, nowMs]);

  let etaLabel: string | null = null;
  if (progress?.stage === "indexing") {
    samplesRef.current = pushSample(samplesRef.current, {
      atMs: nowMs,
      remaining: progress.total - progress.current,
    });
    const etaMs = estimateEtaMs(samplesRef.current);
    etaLabel = etaMs !== null ? formatEta(etaMs) : null;
  } else if (samplesRef.current.length > 0) {
    // Not backfilling — drop history so a later run estimates fresh.
    samplesRef.current = [];
  }

  if (!progress) return null;
  const fmt = (v: number) => v.toLocaleString("en-US");
  return (
    <p
      className="font-accent text-[10px] text-ink-subtle"
      role="status"
      aria-live="polite"
    >
      {STAGE_LABEL[progress.stage]} · {fmt(progress.current)} / {fmt(progress.total)}
      {etaLabel ? ` · ${etaLabel}` : ""}
    </p>
  );
}
