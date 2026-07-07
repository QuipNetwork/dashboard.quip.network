// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

import clsx from "clsx";

interface StatTileProps {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  accent?: string;
  className?: string;
}

export function StatTile({ label, value, sublabel, accent = "#059669", className }: StatTileProps) {
  return (
    <div className={clsx("border border-border bg-white p-5", className)}>
      <p className="font-accent text-[10px] uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-2 font-heading text-3xl tracking-tight" style={{ color: accent }}>
        {value}
      </p>
      {sublabel && <p className="mt-1 font-accent text-xs text-ink-subtle">{sublabel}</p>}
    </div>
  );
}
