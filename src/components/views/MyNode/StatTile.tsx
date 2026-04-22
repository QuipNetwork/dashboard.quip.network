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
    <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-5 backdrop-blur-xl transition-colors hover:border-brand-gray-3">
      <p className="font-accent text-[10px] uppercase tracking-wider text-brand-gray-3">{label}</p>
      <p
        className="mt-2 font-heading text-3xl tracking-tight"
        style={{ color: accent, textShadow: `0 0 18px ${accent}33` }}
      >
        {value}
      </p>
      {sublabel && <p className="mt-1 font-accent text-xs text-brand-gray-3">{sublabel}</p>}
    </div>
  );
}
