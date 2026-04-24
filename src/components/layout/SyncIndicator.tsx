// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { computeChainHealth, type SyncStage } from "../../lib/staleness";
import { selectTipBlockTimestampMs, useTelemetryStore } from "../../store/telemetry-store";

const STYLES: Record<
  SyncStage,
  {
    bg: string;
    border: string;
    text: string;
    dotColor: string;
    dotAnim: "pulse" | "spin" | "static";
  }
> = {
  connecting: {
    bg: "bg-[#A9A9A9]/10",
    border: "border-[#A9A9A9]/40",
    text: "text-[#A9A9A9]",
    dotColor: "#A9A9A9",
    dotAnim: "spin",
  },
  synchronizing: {
    bg: "bg-[#4CE0FF]/10",
    border: "border-[#4CE0FF]/40",
    text: "text-[#4CE0FF]",
    dotColor: "#4CE0FF",
    dotAnim: "pulse",
  },
  backfilling: {
    bg: "bg-[#F5A623]/10",
    border: "border-[#F5A623]/40",
    text: "text-[#F5A623]",
    dotColor: "#F5A623",
    dotAnim: "pulse",
  },
  caught_up: {
    bg: "bg-[#67E347]/10",
    border: "border-[#67E347]/40",
    text: "text-[#67E347]",
    dotColor: "#67E347",
    dotAnim: "static",
  },
  stalled: {
    bg: "bg-[#E34735]/10",
    border: "border-[#E34735]/60",
    text: "text-[#E34735]",
    dotColor: "#E34735",
    dotAnim: "static",
  },
};

function composeText(stage: SyncStage, detail: string | null): string {
  switch (stage) {
    case "connecting":
      return detail ?? "Connecting to node…";
    case "synchronizing":
      // detail is either "N blocks behind" or "Catching up to new epoch".
      if (detail === null) return "Synchronizing";
      if (detail.startsWith("Catching")) return detail;
      return `Synchronizing · ${detail}`;
    case "backfilling":
      return "Backfilling history";
    case "caught_up":
      return "Live";
    case "stalled":
      return detail ? `Indexer offline · ${detail}` : "Indexer offline";
  }
}

export function SyncIndicator() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const tipBlockTimestampMs = useTelemetryStore(selectTipBlockTimestampMs);

  const health = useMemo(
    () => computeChainHealth({ nowMs: Date.now(), tipBlockTimestampMs, indexer }),
    [indexer, tipBlockTimestampMs],
  );

  const style = STYLES[health.stage];
  const text = composeText(health.stage, health.detail);

  const dotClass =
    style.dotAnim === "spin" ? "animate-spin" : style.dotAnim === "pulse" ? "animate-pulse" : "";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-[5px] font-accent text-[11px] ${style.bg} ${style.border} ${style.text}`}
      role="status"
      aria-live="polite"
    >
      {style.dotAnim === "spin" ? (
        <span
          className={`inline-block h-[10px] w-[10px] rounded-full border-2 ${dotClass}`}
          style={{ borderColor: style.dotColor, borderTopColor: "transparent" }}
          aria-hidden
        />
      ) : (
        <span
          className={`inline-block h-[7px] w-[7px] rounded-full ${dotClass}`}
          style={{ backgroundColor: style.dotColor }}
          aria-hidden
        />
      )}
      {text}
    </span>
  );
}
