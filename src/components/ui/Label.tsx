// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LabelHTMLAttributes, ReactNode } from "react";

import clsx from "clsx";

export type EyebrowSize = "xs" | "sm" | "md";

const eyebrowBase = "font-mono uppercase tracking-[0.4px] text-ink-subtle";

const eyebrowSizes: Record<EyebrowSize, string> = {
  xs: "text-[11px]",
  sm: "text-eyebrow",
  md: "text-[13px]",
};

interface EyebrowProps {
  size?: EyebrowSize;
  className?: string;
  children: ReactNode;
}

export function Eyebrow({ size = "sm", className = "", children }: EyebrowProps) {
  return <span className={clsx(eyebrowBase, eyebrowSizes[size], className)}>{children}</span>;
}

interface FormLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  size?: EyebrowSize;
  children: ReactNode;
}

export function FormLabel({ size = "sm", className = "", children, ...rest }: FormLabelProps) {
  return (
    <label className={clsx("block", eyebrowBase, eyebrowSizes[size], className)} {...rest}>
      {children}
    </label>
  );
}
