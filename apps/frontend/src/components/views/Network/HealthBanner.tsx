// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChainHealth } from "@/lib/staleness";

export function HealthBanner({ health }: { health: ChainHealth }) {
  if (health.level === "healthy") return null;
  const isStalled = health.level === "stalled";
  return (
    <div
      role="status"
      className={
        isStalled
          ? "mb-2 border border-red-500/40 bg-red-500/10 px-3 py-2 font-accent text-xs text-red-700"
          : "mb-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-accent text-xs text-amber-700"
      }
    >
      <span className="mr-1.5" aria-hidden="true">
        {isStalled ? "■" : "▲"}
      </span>
      {health.reason}
    </div>
  );
}
