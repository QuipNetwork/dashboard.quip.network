import type { ReactNode } from "react";

import { Card } from "@/components/ui/Card";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, subtitle, children, className = "" }: ChartCardProps) {
  return (
    <Card padding="md" className={className}>
      <div className="mb-4">
        <h2 className="font-heading text-lg text-ink-strong">{title}</h2>
        {subtitle && <p className="font-accent text-xs text-ink-subtle">{subtitle}</p>}
      </div>
      <div className="h-72">{children}</div>
    </Card>
  );
}
