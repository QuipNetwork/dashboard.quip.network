// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

// The "All Nodes | Best Nodes" scope shared by the by-difficulty charts:
// "best" narrows the data to each processor type's single top winner.
export type NodeScope = "all" | "best";

export const NODE_SCOPE_OPTIONS: ReadonlyArray<SegOption<NodeScope>> = [
  { value: "all", label: "All Nodes" },
  { value: "best", label: "Best Nodes" },
];

// Compact segmented control for in-chart toggles, styled to match the
// header's aggregation toggle.
export function SegToggle<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<SegOption<T>>;
  ariaLabel: string;
}) {
  return (
    <div className="flex overflow-hidden border border-border" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={clsx(
              "cursor-pointer px-2.5 py-1 font-accent text-xs transition-colors",
              active
                ? "bg-surface-dark text-ink-on-dark"
                : "text-ink-subtle hover:bg-surface-1 hover:text-ink-strong",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
