// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "positive" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-surface-dark hover:bg-surface-darker text-ink-on-dark",
  secondary: "border border-border bg-white text-ink-strong hover:border-ink-strong",
  quiet: "bg-transparent text-ink-subtle hover:text-ink-strong",
  positive: "bg-positive text-ink-on-dark hover:brightness-95",
  danger: "bg-coral text-ink-on-dark hover:brightness-95",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-4 py-2 text-sm sm:px-6 sm:py-3 sm:text-base",
};

const baseStyles =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-brand-sm font-sans transition duration-150 disabled:cursor-not-allowed disabled:opacity-50";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
  children?: ReactNode;
}

type AsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & { as?: "button" };

type AsAnchor = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & { as: "a" };

export type ButtonProps = AsButton | AsAnchor;

export function Button(props: ButtonProps) {
  const {
    as,
    variant = "primary",
    size = "md",
    fullWidth,
    leftIcon,
    rightIcon,
    className,
    children,
    ...rest
  } = props;
  const cls = cx(
    baseStyles,
    variantStyles[variant],
    sizeStyles[size],
    fullWidth && "w-full",
    className,
  );

  if (as === "a") {
    return (
      <a className={cls} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {leftIcon}
        {children}
        {rightIcon}
      </a>
    );
  }
  return (
    <button className={cls} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
