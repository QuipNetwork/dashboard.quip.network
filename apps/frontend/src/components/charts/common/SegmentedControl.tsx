// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  // Accessible name for the button group — also how tests find the control.
  ariaLabel: string;
}

/**
 * Compact button-group toggle used in chart headers (range windows,
 * aggregation modes). One always-active segment; clicking another moves it.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>) {
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
              "cursor-pointer px-2 py-1 font-accent text-xs transition-colors",
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
