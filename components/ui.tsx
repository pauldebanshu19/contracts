"use client";

import { clsx, type ClassValue } from "clsx";
import { Loader2, X } from "lucide-react";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";

/** Small UI primitives in the shadcn style: plain Tailwind, no runtime theme. */

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-text disabled:bg-accent/50",
  secondary: "bg-surface text-text border border-border shadow-xs hover:bg-surface-2 disabled:text-text-3 disabled:shadow-none",
  ghost: "text-text-2 hover:bg-surface-3 hover:text-text disabled:text-text-3",
  danger: "bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:text-text-3 disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("h-4 w-4 animate-spin", className)} />;
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "accent" | "verified" | "unverified" | "danger"; children: ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-surface-2 text-text-2",
    accent: "bg-accent-soft text-accent-text",
    verified: "bg-verified-soft text-verified",
    unverified: "bg-unverified-soft text-unverified",
    danger: "bg-danger-soft text-danger",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", tones[tone], className)}>{children}</span>;
}

const DOC_COLORS = ["var(--doc-1)", "var(--doc-2)", "var(--doc-3)", "var(--doc-4)", "var(--doc-5)"];

export function docColor(alias: string | null | undefined): string {
  const n = Number(alias?.replace(/\D/g, "") ?? 1);
  return DOC_COLORS[(Math.max(1, n) - 1) % DOC_COLORS.length];
}

export function DocBadge({ alias, name, className }: { alias: string | null; name?: string; className?: string }) {
  const tag = (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-4 text-white" style={{ background: docColor(alias) }}>
      {alias}
    </span>
  );
  if (!name) return <span className={cn("inline-flex", className)}>{tag}</span>;
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-surface py-0.5 pl-0.5 pr-2 text-xs text-text-2", className)}
      title={name}
    >
      {tag}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A modal dialog on the native <dialog> element: focus trapping and Esc come for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/30"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="px-5 py-4 text-sm text-text-2">{children}</div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
    </dialog>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
