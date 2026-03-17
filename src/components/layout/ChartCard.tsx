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
      className={`rounded-xl border border-brand-gray-1 bg-brand-gray-1/50 p-5 shadow-[0_0_20px_rgba(103,227,71,0.03)] ${className}`}
    >
      <div className="mb-4">
        <h2 className="font-heading text-lg text-brand-gray-5">{title}</h2>
        {subtitle && (
          <p className="font-accent text-xs text-brand-gray-3">{subtitle}</p>
        )}
      </div>
      <div className="h-72">{children}</div>
    </div>
  );
}
