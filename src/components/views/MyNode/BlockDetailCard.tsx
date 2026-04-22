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
export function BlockDetailCard({ label, rows, accent = "#67E347", footer }: BlockDetailCardProps) {
  return (
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-5 backdrop-blur-xl transition-colors hover:border-brand-gray-3">
      <p className="font-accent text-[10px] uppercase tracking-wider text-brand-gray-3">{label}</p>
      <dl className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="font-accent text-xs text-brand-gray-3">{r.label}</dt>
            <dd
              className="font-accent text-sm tabular-nums"
              style={{ color: accent, textShadow: `0 0 8px ${accent}22` }}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {footer && <p className="mt-3 font-accent text-xs text-brand-gray-3">{footer}</p>}
    </div>
  );
}
