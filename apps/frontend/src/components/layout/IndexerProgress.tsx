// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { computeIndexerProgress } from "@/lib/indexer-progress";
import { selectServerNowMs, useTelemetryStore } from "@/store/telemetry-store";

const STAGE_LABEL = {
  "node-sync": "Node sync",
  indexing: "Indexing",
} as const;

// Progress line under "Connected Miner": validator node sync, then dashboard
// backfill, then nothing once live. All state lives in the pure helper; this
// component only reads the store and formats.
export function IndexerProgress() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const nowMs = useTelemetryStore(selectServerNowMs);
  const progress = useMemo(() => computeIndexerProgress(indexer, nowMs), [indexer, nowMs]);
  if (!progress) return null;
  const fmt = (v: number) => v.toLocaleString("en-US");
  return (
    <p
      className="font-accent text-[10px] text-ink-subtle"
      role="status"
      aria-live="polite"
    >
      {STAGE_LABEL[progress.stage]} · {fmt(progress.current)} / {fmt(progress.total)}
    </p>
  );
}
