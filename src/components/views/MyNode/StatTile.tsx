// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

interface StatTileProps {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  accent?: string;
}

export function StatTile({ label, value, sublabel, accent = "#67E347" }: StatTileProps) {
  return (
    <div className="border border-border bg-white p-5 transition-colors hover:border-border-strong">
      <p className="font-accent text-[10px] uppercase tracking-wider text-ink-subtle">{label}</p>
      <p
        className="mt-2 font-heading text-3xl tracking-tight"
        style={{ color: accent, textShadow: `0 0 18px ${accent}33` }}
      >
        {value}
      </p>
      {sublabel && <p className="mt-1 font-accent text-xs text-ink-subtle">{sublabel}</p>}
    </div>
  );
}
