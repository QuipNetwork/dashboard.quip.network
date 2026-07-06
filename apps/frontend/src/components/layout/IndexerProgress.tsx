// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { formatEta } from "@/lib/indexer-eta";
import { computeIndexerProgress } from "@/lib/indexer-progress";
import { useServerNowMs, useTelemetryStore } from "@/store/telemetry-store";

const STAGE_LABEL = {
  "node-sync": "Node sync",
  indexing: "Indexing",
} as const;

// Progress line under "Connected Miner": validator node sync, then dashboard
// backfill (with a server-computed ETA), then nothing once live.
export function IndexerProgress() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const nowMs = useServerNowMs();
  const progress = useMemo(() => computeIndexerProgress(indexer, nowMs), [indexer, nowMs]);
  if (!progress) return null;
  const fmt = (v: number) => v.toLocaleString("en-US");
  const etaSec = progress.stage === "indexing" ? indexer?.indexer?.backfillEtaSeconds : null;
  const eta = typeof etaSec === "number" && etaSec > 0 ? ` · ${formatEta(etaSec * 1000)}` : "";
  return (
    <p className="font-accent text-[10px] text-ink-subtle" role="status" aria-live="polite">
      {STAGE_LABEL[progress.stage]} · {fmt(progress.current)} / {fmt(progress.total)}
      {eta}
    </p>
  );
}
