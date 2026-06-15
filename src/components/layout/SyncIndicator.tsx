// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import {
  computeChainHealth,
  computeSubstrateHealth,
  type SubstrateHealthLevel,
  type SyncStage,
} from "@/lib/staleness";
import {
  selectServerNowMs,
  selectTipBlockTimestampMs,
  useTelemetryStore,
} from "@/store/telemetry-store";

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
      return detail ?? "Connecting to miner…";
    case "caught_up":
      return "Live";
    case "stalled":
      return detail ? `Indexer offline · ${detail}` : "Indexer offline";
  }
}

// Substrate-dot colors. "disabled" hides the dot entirely (rendered as
// null below) so deployments without a configured validator don't show a
// distracting indicator.
const SUBSTRATE_DOT_STYLES: Record<
  Exclude<SubstrateHealthLevel, "disabled">,
  { dotColor: string; dotAnim: "pulse" | "static"; title: string }
> = {
  ok: { dotColor: "#67E347", dotAnim: "static", title: "Substrate validator connected" },
  stale: {
    dotColor: "#F5A623",
    dotAnim: "pulse",
    title: "Substrate events have slowed",
  },
  offline: {
    dotColor: "#E34735",
    dotAnim: "static",
    title: "Substrate validator unreachable",
  },
};

export function SyncIndicator() {
  const indexer = useTelemetryStore((s) => s.indexer);
  const tipBlockTimestampMs = useTelemetryStore(selectTipBlockTimestampMs);
  // Server-anchored "now" — audit fix #3. Falls back to Date.now() until
  // the first telemetry response lands.
  const nowMs = useTelemetryStore(selectServerNowMs);

  // Depend on the primitive fields computeChainHealth /
  // computeSubstrateHealth actually read, not on the `indexer` object
  // reference. Primitive deps make the memo invalidate exactly when the
  // output could change.
  const health = useMemo(
    () => computeChainHealth({ nowMs, tipBlockTimestampMs, indexer }),
    [
      nowMs,
      tipBlockTimestampMs,
      indexer?.lastStatusFetchAt,
      indexer, // keep for the `indexer === null` branch
    ],
  );
  const substrate = useMemo(
    () => computeSubstrateHealth(indexer, nowMs),
    [nowMs, indexer?.lastSubstrateEventAt, indexer?.chainConnected, indexer],
  );

  const style = STYLES[health.stage];
  const text = composeText(health.stage, health.detail);

  const dotClass =
    style.dotAnim === "spin" ? "animate-spin" : style.dotAnim === "pulse" ? "animate-pulse" : "";

  const substrateStyle =
    substrate.level === "disabled" ? null : SUBSTRATE_DOT_STYLES[substrate.level];

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
      {substrateStyle && (
        <span
          className={`inline-block h-[7px] w-[7px] rounded-full ${
            substrateStyle.dotAnim === "pulse" ? "animate-pulse" : ""
          }`}
          style={{ backgroundColor: substrateStyle.dotColor }}
          title={substrateStyle.title + (substrate.reason ? ` · ${substrate.reason}` : "")}
          aria-label={substrateStyle.title}
        />
      )}
    </span>
  );
}
