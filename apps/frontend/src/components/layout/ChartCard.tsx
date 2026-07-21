import type { ReactNode } from "react";

import { Card } from "@/components/ui/Card";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  // Header controls (range/aggregation toggles), rendered right of the title.
  actions?: ReactNode;
}

export function ChartCard({
  title,
  subtitle,
  children,
  className = "",
  bodyClassName = "h-72",
  actions,
}: ChartCardProps) {
  return (
    <Card padding="md" className={className}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-heading text-lg text-ink-strong">{title}</h2>
          {subtitle && <p className="font-accent text-xs text-ink-subtle">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}
