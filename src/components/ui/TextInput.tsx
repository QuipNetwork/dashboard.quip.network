// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InputHTMLAttributes, ReactNode } from "react";

import clsx from "clsx";

export type TextInputType = "text" | "email" | "number" | "url" | "tel" | "search" | "password";

export type TextInputSize = "sm" | "md";

const sizeStyles: Record<TextInputSize, string> = {
  sm: "p-2 text-sm",
  md: "px-4 py-3 text-sm",
};

const baseStyles =
  "w-full rounded-brand-sm border border-border bg-white text-ink-strong transition-colors placeholder:text-ink-subtle focus:border-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/40 aria-invalid:border-coral";

interface TextInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "size"
> {
  type?: TextInputType;
  value: string;
  onChange?: (value: string) => void;
  size?: TextInputSize;
  mono?: boolean;
  leftAdornment?: ReactNode;
  rightAdornment?: ReactNode;
}

export function TextInput({
  type = "text",
  value,
  onChange,
  size = "md",
  mono = false,
  leftAdornment,
  rightAdornment,
  className = "",
  ...rest
}: TextInputProps) {
  const inputCls = clsx(
    baseStyles,
    sizeStyles[size],
    mono ? "font-mono" : "font-sans",
    leftAdornment ? "pl-10" : "",
    rightAdornment ? "pr-10" : "",
    className,
  );

  const input = (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      className={inputCls}
      {...rest}
    />
  );

  if (!leftAdornment && !rightAdornment) return input;

  return (
    <div className="relative">
      {input}
      {leftAdornment && (
        <div className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center text-ink-subtle">
          {leftAdornment}
        </div>
      )}
      {rightAdornment && (
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center text-ink-subtle">
          {rightAdornment}
        </div>
      )}
    </div>
  );
}
