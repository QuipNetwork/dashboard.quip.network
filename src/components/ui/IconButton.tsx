// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cx } from "@/lib/cx";

export type IconButtonTone =
  | "primary"
  | "secondary"
  | "surface"
  | "outlined"
  | "subtle"
  | "quiet"
  | "positive"
  | "danger";

export type IconButtonSize = "sm" | "md" | "lg";

const toneStyles: Record<IconButtonTone, string> = {
  primary: "bg-surface-dark text-ink-on-dark hover:bg-surface-darker",
  secondary: "border border-border bg-white text-ink-strong hover:border-ink-strong",
  surface:
    "border border-border bg-surface-1 text-ink-strong hover:bg-surface-2 active:bg-surface-3",
  outlined:
    "border border-border bg-transparent text-ink-subtle hover:bg-surface-1 hover:text-ink-strong",
  subtle: "bg-transparent text-ink-subtle hover:bg-surface-2 hover:text-ink-strong",
  quiet: "bg-transparent text-ink-subtle hover:text-ink-strong",
  positive: "bg-positive text-ink-on-dark hover:brightness-95",
  danger: "bg-coral text-ink-on-dark hover:brightness-95",
};

const sizeStyles: Record<IconButtonSize, string> = {
  sm: "p-1",
  md: "p-2",
  lg: "p-3",
};

const iconBoxStyles: Record<IconButtonSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-5 w-5",
};

const baseStyles =
  "inline-flex cursor-pointer items-center justify-center rounded-brand-sm font-sans transition duration-150 disabled:cursor-not-allowed disabled:opacity-50";

interface IconButtonOwnProps {
  tone?: IconButtonTone;
  size?: IconButtonSize;
  label: string;
  children: ReactNode;
}

type IconButtonProps = IconButtonOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof IconButtonOwnProps>;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tone = "subtle", size = "md", label, className = "", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(baseStyles, toneStyles[tone], sizeStyles[size], className)}
      {...rest}
    >
      <span className={cx("flex items-center justify-center", iconBoxStyles[size])}>
        {children}
      </span>
    </button>
  );
});
