// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

import type { CurrentDispatch } from "@/types/telemetry";

const badgeBase = "inline-block border px-1.5 py-0.5 font-accent text-[10px]";

export function StatusBadge({ status }: { status: CurrentDispatch["status"] | "stale" }) {
  const tone =
    status === "in-flight"
      ? "border-positive/40 text-positive"
      : status === "stale"
        ? "border-warning/40 text-warning"
        : "border-border text-ink-body";
  const label =
    status === "in-flight" ? "In flight" : status === "stale" ? "Stale" : "Last completed";
  return <span className={clsx(badgeBase, tone)}>{label}</span>;
}

export function OutcomeBadge({ outcome, prefix = "" }: { outcome: string; prefix?: string }) {
  const lower = outcome.toLowerCase();
  const tone =
    lower.includes("error") || lower.includes("reject")
      ? "border-coral/40 text-coral"
      : lower.includes("inblock") || lower.includes("submitted")
        ? "border-positive/40 text-positive"
        : "border-border text-ink-body";
  return (
    <span className={clsx(badgeBase, tone)}>
      {prefix}
      {outcome}
    </span>
  );
}

export function ResultBadge({ kind }: { kind: string }) {
  const lower = kind.toLowerCase();
  const tone = lower.includes("submitted")
    ? "border-positive/40 text-positive"
    : lower.includes("reject")
      ? "border-coral/40 text-coral"
      : lower.includes("stored")
        ? "border-warning/40 text-warning"
        : "border-border text-ink-body";
  return <span className={clsx(badgeBase, tone)}>{kind || "—"}</span>;
}
