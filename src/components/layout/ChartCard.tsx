import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, subtitle, children, className = "" }: ChartCardProps) {
  return (
    <div
      className={`border border-border bg-white p-5 shadow-[0_0_20px_rgba(103,227,71,0.03)] transition-colors duration-300 hover:border-border-strong ${className}`}
    >
      <div className="mb-4">
        <h2 className="font-heading text-lg text-ink-strong">{title}</h2>
        {subtitle && <p className="font-accent text-xs text-ink-subtle">{subtitle}</p>}
      </div>
      <div className="h-72">{children}</div>
    </div>
  );
}
