// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

export interface DetailRow {
  label: string;
  value: ReactNode;
}

interface BlockDetailCardProps {
  label: string;
  rows: DetailRow[];
  accent?: string;
  // Rendered below the rows; typically a small-text hint like "Block #162".
  footer?: ReactNode;
}

// Card chrome matching StatTile but built for a compact list of labeled fields
// instead of one big-number value. Used by the MyNode "Energy Details" and
// "Current Requirements" tiles.
export function BlockDetailCard({ label, rows, accent = "#059669", footer }: BlockDetailCardProps) {
  return (
    <div className="border border-border bg-white p-5 transition-colors hover:border-border-strong">
      <p className="font-accent text-[10px] uppercase tracking-wider text-ink-subtle">{label}</p>
      <dl className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="font-accent text-xs text-ink-subtle">{r.label}</dt>
            <dd
              className="font-accent text-sm tabular-nums"
              style={{ color: accent, textShadow: `0 0 8px ${accent}22` }}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {footer && <p className="mt-3 font-accent text-xs text-ink-subtle">{footer}</p>}
    </div>
  );
}
