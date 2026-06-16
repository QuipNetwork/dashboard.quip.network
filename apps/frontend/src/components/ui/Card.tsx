// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HTMLAttributes, ReactNode } from "react";

import clsx from "clsx";

export type CardPadding = "sm" | "md" | "lg" | "xl";

const paddingStyles: Record<CardPadding, string> = {
  sm: "p-4",
  md: "p-4 sm:p-6",
  lg: "p-6",
  xl: "p-12 sm:p-16",
};

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  children: ReactNode;
}

export function Card({ padding = "lg", className = "", children, ...rest }: CardProps) {
  return (
    <div
      className={clsx("border border-border bg-white", paddingStyles[padding], className)}
      {...rest}
    >
      {children}
    </div>
  );
}
