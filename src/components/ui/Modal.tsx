// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";
import { IconButton } from "./IconButton";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "4xl";

const sizeStyles: Record<ModalSize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
  xl: "sm:max-w-xl",
  "4xl": "sm:max-w-4xl",
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ModalContextValue {
  onClose: () => void;
  titleId: string;
}

const ModalContext = createContext<ModalContextValue | null>(null);

function useModalContext(component: string): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error(`${component} must be used inside <Modal>`);
  return ctx;
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  size?: ModalSize;
  zIndex?: number;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  className?: string;
  backdropClassName?: string;
  ariaLabel?: string;
  children: ReactNode;
}

export function Modal({
  isOpen,
  onClose,
  size = "md",
  zIndex = 50,
  closeOnBackdrop = true,
  closeOnEscape = true,
  className = "",
  backdropClassName = "",
  ariaLabel,
  children,
}: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, closeOnEscape, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && e.target === e.currentTarget) onClose();
  };

  const onDialogBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const next = e.relatedTarget as Node | null;
    if (next && dialog.contains(next)) return;
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? dialog).focus();
  };

  return (
    <ModalContext.Provider value={{ onClose, titleId }}>
      <div
        onClick={onBackdropClick}
        style={{ zIndex }}
        className={cx(
          "fixed inset-0 flex items-end justify-center bg-black/50 font-sans sm:items-center sm:p-4",
          backdropClassName,
        )}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabel ? undefined : titleId}
          aria-label={ariaLabel}
          tabIndex={-1}
          onBlur={onDialogBlur}
          className={cx(
            "flex max-h-[90vh] w-full flex-col border-t border-border bg-white p-6 focus:outline-none sm:border",
            sizeStyles[size],
            className,
          )}
        >
          {children}
        </div>
      </div>
    </ModalContext.Provider>
  );
}

interface ModalSlotProps {
  children?: ReactNode;
  className?: string;
}

function ModalHeader({ children, className = "" }: ModalSlotProps) {
  const { titleId } = useModalContext("Modal.Header");
  return (
    <div className={cx("mb-4 flex items-start justify-between gap-4", className)}>
      <h2 id={titleId} className="font-display text-h4 font-medium text-ink-strong">
        {children}
      </h2>
      <ModalCloseButton />
    </div>
  );
}

function ModalCloseButton({ className = "" }: { className?: string }) {
  const { onClose } = useModalContext("Modal.CloseButton");
  return (
    <IconButton
      tone="quiet"
      label="Close"
      onClick={onClose}
      className={cx("-mr-1 -mt-1", className)}
    >
      <span aria-hidden className="text-lg leading-none">
        ×
      </span>
    </IconButton>
  );
}

function ModalBody({ children, className = "" }: ModalSlotProps) {
  return <div className={cx("-mx-6 flex-1 overflow-y-auto px-6", className)}>{children}</div>;
}

function ModalFooter({ children, className = "" }: ModalSlotProps) {
  return <div className={cx("mt-6 flex justify-end gap-3", className)}>{children}</div>;
}

Modal.Header = ModalHeader;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
Modal.CloseButton = ModalCloseButton;
